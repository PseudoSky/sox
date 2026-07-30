# Spec — `@adhd/sox-executor`: driver-agnostic multi-process execution

- **Status:** DRAFT (2026-07-23). Not yet scheduled; not scaffolded.
- **Owner:** pseudosky.
- **Kind:** Architecture specification (design document). This is **not** an
  implementation. Signatures and pseudocode are illustrative.
- **Relationship to existing docs:** This spec builds on
  [ADR 0007 — Memory single-writer architecture](../decisions/0007-memory-single-writer-architecture.md).
  ADR 0007's invariant — *"at most one writer commits to a given store at a time"* — is
  preserved verbatim; what this spec changes is **where that invariant is enforced**. ADR 0007
  hand-builds a single elected owner process to serialize writes to `~/.memory/memory.db`;
  `@adhd/sox-executor` moves cross-process write serialization **into the database engine**
  (Turso `multiprocess_wal`, §6) and keeps the executor as a thin, reusable, driver-agnostic
  layer for in-process ergonomics, idempotency, durability, and background draining. ADR
  0007 D9's storage-agnostic write seam is realised here as the `DbAdapter` (§2.5).
- **Convention note:** placed in `docs/spec/` alongside `service-lifecycle.md` (the repo's
  home for full buildable specs); architecture *decisions* distilled from this spec should be
  recorded as a numbered ADR in `docs/decisions/` (next number: `0009`) when accepted.

---

## 0. TL;DR

`@adhd/sox-executor` wraps any operation so it runs with **concurrency-controlled,
crash-durable, multi-process-safe** execution against an embedded resource, while the call
site stays `await fn(x)`. Nothing in its core is engine-specific.

**The decided architecture:** the **database engine owns cross-process write coordination**.
Turso Database's `multiprocess_wal` (VERIFIED, §6) lets many OS processes open one file and
write safely — coordinated through a `.tshm` shared-memory file, with writers serialized on a
single-writer slot (blocking, never corrupting), readers never blocked by writers, and
consistent cross-process snapshots. Every process opens the DB directly through a
`DbAdapter`; there is **no elected owner process and no application-level write funnel** — the
only cross-process coordination is the engine's own `.tshm` shared memory + OFD/fcntl locks,
below the application.

The executor therefore provides, *on top of* the engine's coordination:

1. an ergonomic **function wrapper** (`queued`) with in-process lanes, bounded backpressure,
   and honest async;
2. **idempotency** keys so retries never double-write;
3. opt-in **durability** (`durable`) for effects that span more than one transaction;
4. an optional **background worker** — the one thing the engine does *not* provide: a process
   that outlives short-lived CLIs to drain deferred/queued work;
5. all of it behind the **`DbAdapter`** seam, so the engine (Turso, better-sqlite3, libSQL) is
   a single factory-call choice.

**Accepted risk (owner decision):** Turso `multiprocess_wal` is pre-1.0 and marked
experimental (on-disk coordination format may change; 64-bit Unix only). This is adopted
deliberately as the backbone. The JS-side adapter (`@adhd/sox-store-adapter`) already enables
`multiprocess_wal` by default in its `createTursoAdapter()` — so every sox-ecosystem extension
that uses the factory's default (`STORE_ADAPTER` unset → `'turso'`) ships with multi-process
write coordination active. §6.6 records the mitigations (version pinning, backups,
integration gates, and a single-process fallback adapter).

---

## 1. Problem statement & the write-serialization law

### 1.1 The two forces

1. **Embedded writes serialize.** SQLite and its descendants allow many concurrent readers
   but **one committing writer at a time**. This is the engine contract, and (VERIFIED, §6)
   no embedded engine offers genuinely *parallel* multi-process writes — the best available
   is *safe, coordinated, serialized* multi-process writes.
2. **Consumers are many short-lived processes.** The ecosystem is a fleet of CLIs, MCP hosts,
   and agents. On 2026-07-02/03 the memory store was served by up to nine uncoordinated
   processes with no busy handling, producing caller-visible `database is locked` errors and
   a `SQLITE_BUSY` error-loop (ADR 0007 Context; BL-118). A short-lived CLI **also cannot do
   background work** — it exits, taking any in-process queue or drainer with it.

### 1.2 The law

> **At most one writer commits to a given resource identity at a time; every reader observes
> a consistent snapshot.**

This spec upholds the law by **delegating its cross-process enforcement to the engine**:
Turso `multiprocess_wal`'s single-writer slot serializes committers across processes and its
reader slots pin consistent snapshots (§6.2). Within a single process, the executor's lane
scheduler serializes further and adds backpressure and idempotency. The law is thus enforced
at two cooperating levels — engine (cross-process) and executor (in-process) — with **no
elected owner process** in between.

### 1.3 What the library is (and is not)

- **Is:** a function wrapper. `const write = queued(rawWrite, opts)` returns a function with
  the same call signature; lanes, backpressure, idempotency, durability, and background
  draining are all behind the wrapper. The call site never changes.
- **Is:** driver-agnostic **by way of the `DbAdapter` seam (§2.5)**. The core knows nothing
  about SQLite, drizzle, better-sqlite3, or Turso — only about *identities*, *lanes*,
  *serializable work items*, and the capability-flagged `DbAdapter` a consumer hands it.
- **Is not:** a database. It does not replace `@adhd/sox-graph-store`; it hosts its write
  path over an adapter. It does not implement a query engine or an ORM.
- **Is not:** a coordinator process. Cross-process write safety comes from the engine, not
  from an executor-owned daemon. The executor's optional background worker is a *drain
  participant*, not a write gatekeeper.
- **Is not:** a distributed system. Single machine, single file. Cross-host is out of scope
  (that is ADR 0007 D9's "libSQL server / Postgres" ramp, not this package).

---

## 2. Public API surface

### 2.1 The two tiers — why closures still matter

A JavaScript closure that captures a live handle (an open connection, a socket) **cannot
cross a thread boundary** — you cannot `postMessage` an open connection to a worker thread.
This still dictates the API, even though cross-*process* coordination is now the engine's job
(each process opens its own connection through the adapter):

| Tier | Shape of `fn` | Where the fn body can run |
|---|---|---|
| **captured** (`inline`-only) | closes over a live handle: `(args) => conn.exec(...)` | the calling thread only |
| **relocatable** | resource injected as an argument, not captured; args + result serializable: `(ctx, args) => ctx.writeNode(...)` | calling thread **or** a worker thread |

The discipline is one sentence: **inject the resource, don't capture it.** A relocatable
function is defined once and can run in the caller's thread or on a worker, unchanged. The
type system enforces the tier.

```ts
// Captured — runs on the calling thread only; the closure owns a live handle.
type CapturedFn<A extends unknown[], R> = (...args: A) => R | Promise<R>;

// Relocatable — the resource arrives via `ctx`, which the executor builds from an
// adapter-opened DbConnection (§2.5). A is the serializable arg tuple; R the result.
//   e.g. RelocatableFn<GraphBackend, [content, meta], number>
//        = (graph, content, meta) => graph.writeNode(content, meta)
type RelocatableFn<Ctx, A extends Serializable[], R extends Serializable> =
  (ctx: Ctx, ...args: A) => R | Promise<R>;
```

### 2.2 `queued` — the wrapper

```ts
export interface QueuedOptions<Ctx = DbConnection> {
  /** Resource identity — the absolute DB file path (canonicalised). Wrappers sharing an
   *  identity share one in-process lane set; cross-process, the engine coordinates them. */
  identity: string;

  /** The DB engine — ALWAYS behind an adapter (§2.5), never a raw driver. Each process
   *  opens its own connection through it; the adapter's `capabilities.multiprocessWrite`
   *  declares whether cross-process writes are engine-coordinated. One of the factories:
   *  tursoAdapter (default, multi-process — multiprocess_wal enabled by default) | betterSqliteAdapter | libsqlRustAdapter. */
  adapter: DbAdapter;

  /** Build the injected resource from the process-local DbConnection. Called once per
   *  process, lazily. This is where a store is composed over the connection — e.g.
   *    resource: (conn) => createGraphBackend(conn)
   *  Defaults to identity (Ctx = the raw DbConnection). REQUIRED for relocatable fns that
   *  need a richer handle; forbidden for captured fns. */
  resource?: (conn: DbConnection) => Ctx | Promise<Ctx>;

  /** In-process lanes. Default: one serialized 'write' lane (concurrency 1) so a burst of
   *  local writes queues locally instead of hammering the engine's writer slot; reads get a
   *  parallel lane. Cross-process serialization is still the engine's (§6). */
  lanes?: Record<string, { concurrency: number }>;
  lane?: string;                 // which lane this fn uses; default 'write'

  /** Where the wrapped fn BODY runs. Default 'inline' (calling thread). 'worker' offloads
   *  CPU-bound relocatable work to a worker thread. This is NOT about cross-process
   *  coordination — that is always the engine's job. */
  execution?: 'inline' | 'worker';

  /** Bounded backpressure. When a lane's queue is full, reject (default) or block. Also
   *  bounds how many local callers pile onto the engine's single writer slot. */
  maxPending?: number;
  onFull?: 'reject' | 'block';

  /** Idempotency key extractor. A retry with the same key returns the original result
   *  instead of re-executing (§4, backed by the request-ledger pattern of §5.3). */
  idempotencyKey?: (...args: A) => string;
}

export function queued<A extends unknown[], R>(
  fn: CapturedFn<A, R>,
  opts: QueuedOptions & { execution?: 'inline' }
): (...args: A) => Promise<R>;

export function queued<Ctx, A extends Serializable[], R extends Serializable>(
  fn: RelocatableFn<Ctx, A, R>,
  opts: QueuedOptions<Ctx>
): (...args: A) => Promise<R>;
```

The **return is always `Promise<R>`**, even when the adapter is synchronous (e.g.
`betterSqliteAdapter`). This is deliberate: work may run on a worker thread, and a Turso
async-I/O adapter runs off the event loop, so the call site must already be `await`-shaped.

**Worked example — the adapter is the only place the engine is named, and it is
multi-process by default.**

```ts
import { queued, tursoAdapter } from '@adhd/sox-executor';
import { createGraphBackend } from '@adhd/sox-graph-store';

const writeNode = queued(
  (graph, content: string, meta: NodeMeta) => graph.writeNode(content, meta),
  {
    identity: '/Users/me/.adhd/memory.db',
    adapter: tursoAdapter({ path: '/Users/me/.adhd/memory.db' }),  // multiprocess_wal enabled by default
    resource: (conn) => createGraphBackend(conn),
  },
);

await writeNode('hello', { kind: 'episode' });   // 20 CLIs can run this concurrently, safely
```

Twenty separate `writeNode` processes may run this concurrently against the same file: each
opens its own connection through `tursoAdapter`, and the engine serializes the committers on
its writer slot (§6.2) — no daemon, no election, no application-level funnel (coordination is
the engine's shared-memory layer). Swapping to `betterSqliteAdapter`
(single-process, `multiprocessWrite: false`) is a one-line change that the type/runtime flags
as unsafe for concurrent processes (§6.5).

### 2.3 `durable` — the opt-in durability composition

```ts
/** Wrap a queued fn so its effect survives a crash mid-flight. OFF by default.
 *  Composes OUTSIDE queued: durable(queued(fn, o)). See §3.2 / §5.2. */
export function durable<A extends unknown[], R>(
  wrapped: (...args: A) => Promise<R>,
  opts: DurableOptions
): (...args: A) => Promise<R>;

export interface DurableOptions {
  /** The journal/outbox. MUST be committed in the SAME transaction as the business write
   *  (§5.2), so in practice a table in the same DB file. */
  journal: JournalBackend;
  /** Idempotent resume: replays unfinished journal entries. Runs opportunistically in any
   *  process that opens the store, and in the background worker (§3.3). Each entry is keyed
   *  so a half-applied effect is completed, never double-applied. */
  resume: (entry: JournalEntry, ctx: unknown) => Promise<void>;
}
```

### 2.4 Core in Rust — one crate, two frontends (USER DECISION 1)

The executor core is implemented **once in a Rust core crate** and exposed through **two
frontends**:

```
                    ┌─────────────────────────────┐
                    │  sox-executor-core (Rust)    │
                    │  - lane scheduler + queue    │
                    │  - idempotency ledger        │
                    │  - journal / resume          │
                    │  - background-drain lifecycle│
                    │  - opens a DbAdapter conn    │  ← tursoAdapter (multiprocess_wal)
                    │    (Tokio async runtime)     │     / libsqlRustAdapter
                    └───────────┬─────────┬────────┘
                                │         │
          ┌─────────────────────┘         └─────────────────────┐
          ▼                                                      ▼
┌──────────────────────────┐                    ┌──────────────────────────────┐
│ napi-rs Node addon       │                    │ Background-drain daemon       │
│ (@adhd/sox-executor)     │                    │ (sox-executord, optional)     │
│ - long-lived Node server │                    │ - a drain PARTICIPANT, not a  │
│   embeds the core        │                    │   write owner                 │
│ - Tokio async →          │                    │ - spawned when deferred work  │
│   non-blocking TS API    │                    │   outlives short-lived CLIs   │
└──────────────────────────┘                    │ - idle-drains, then exits     │
                                                 └──────────────────────────────┘
```

- **Frontend A — the napi-rs native Node addon (`@adhd/sox-executor`).** A long-lived Node
  server (e.g. a memory MCP server) embeds the core in-process. Because the core runs on
  **Tokio**, DB work runs **off the JS event loop** and the TS API is genuinely non-blocking —
  something `better-sqlite3` (synchronous) cannot do. Same tech as SWC / Biome / Turbopack /
  Prisma's query engine.
- **Frontend B — the background-drain daemon (`sox-executord`, optional).** Under the
  multi-process model, short-lived CLIs write **directly** (the engine coordinates them), so
  they do **not** connect to a daemon for writes. The daemon's sole remaining job is
  **deferred work**: draining the durable/journaled backlog after the CLIs that enqueued it
  have exited. It is one more `multiprocess_wal` participant, not a gatekeeper; it idle-drains
  and exits (or lingers as a daemon — one `idleMs` knob).

Both frontends link the **same** `sox-executor-core` and open the DB through the **same
`DbAdapter` contract**, so scheduling, idempotency, and durability have exactly one
implementation and the addon-vs-daemon choice is a frontend choice, not a re-implementation.

**V1 is Rust, not TypeScript (owner decision).** The core crate and both adapters ship in
Rust from the first release; there is no TypeScript implementation of the core. The Node-facing
V1 artifact is the **napi addon** — Rust core, generated TS types. Because the core holds the
engine connection in Rust (Tokio), the `DbConnection` it hands to TypeScript across napi is
**asynchronous**; TS consumers (graph-store, the absorbed queue) compose over that async
connection (§5.4). A purely synchronous, pure-TypeScript path exists only through the optional
`betterSqliteAdapter` escape hatch (§6.5) for single-process consumers that do not embed the
Rust core.

### 2.5 Database adapter pattern — engines stay behind an adapter (DESIGN DIRECTIVE)

**The executor never hardwires an engine. Every database engine is reached through a
capability-flagged `DbAdapter`,** and every consumer (the executor core, `@adhd/sox-graph-
store`, the absorbed queue) programs against that interface — never against `better-sqlite3`,
`rusqlite`, or a Turso client type. This continues the repo's established idiom: graph-store
already exposes a capability-flagged `GraphBackend` (`GraphBackendCapabilities` =
`{bitemporal, fullTextSearch, metadataFilter}`, `index.ts:328`) behind a
`createGraphBackend(db)` factory. The adapter sits one level **below** `GraphBackend`, at the
engine boundary (which `createGraphBackend` today still hardwires to `Database.Database`,
`index.ts:684,1531` — §5.4 / BACKLOG).

The adapter is what lets the decided model hold cleanly: the *engine* provides multi-process
coordination, and the *capability flags* tell the executor whether an adapter can be trusted
for concurrent processes (`multiprocessWrite`) and how (async I/O, native vectors).

```ts
/** What an engine can do — declares its multi-process safety and drives feature use. */
export interface DbCapabilities {
  /** Engine coordinates safe writes across OS processes on one file (Turso
   *  multiprocess_wal). If false, the adapter is single-process only — using it from
   *  multiple processes is rejected at open time (§6.5). */
  multiprocessWrite: boolean;
  /** Genuinely parallel writes within one process (MVCC / BEGIN CONCURRENT). Never
   *  combined with multiprocessWrite (§6.2). */
  mvcc: boolean;
  /** DB work runs off the caller's thread (Turso async I/O; napi Tokio). */
  asyncIo: boolean;
  /** Native vector column + ANN search (lets node + embedding share one tx, §5.1). */
  nativeVectors: boolean;
  /** OS constraints — multiprocessWrite is 64-bit Unix only (§6). */
  platforms: ReadonlyArray<'linux' | 'macos' | 'windows'>;
}

/** The engine seam. Sync OR async — the executor always exposes a Promise API (§2.2). */
export interface DbAdapter {
  readonly capabilities: DbCapabilities;
  /** Open a process-local connection bound to a resource identity. `mode` lets a reader
   *  open readonly/query_only (ADR 0007 D2). Under multiprocessWrite, many processes may
   *  each call this and write safely. */
  connect(identity: string, mode: 'writer' | 'readonly'): Promise<DbConnection>;
}

export interface DbConnection {
  exec(sql: string): Promise<void>;
  prepare<Row = unknown>(sql: string): DbStatement<Row>;
  /** Deferred by default; `immediate:true` requests BEGIN IMMEDIATE where supported — the
   *  fix for graph-store's deferred-upgrade hazard (§5.1). */
  transaction<T>(fn: (tx: DbConnection) => T | Promise<T>,
                 opts?: { immediate?: boolean }): Promise<T>;
  close(): Promise<void>;
}

// Engine factories — the ONLY place an engine is named. All V1 adapters are Rust
// (behind the core / napi); the engine connection lives in Rust.
export function tursoAdapter(opts: {          // V1 default: multi-process backbone (Rust turso crate)
  path: string;
  multiprocessWal?: boolean;                  // true → capabilities.multiprocessWrite
}): DbAdapter;
export function libsqlRustAdapter(opts: { path: string }): DbAdapter;  // Rust, single-process fallback (rusqlite/libsql)

// Optional pure-TypeScript escape hatch — NOT part of the Rust core. Single-process only,
// synchronous, for a Node consumer that does not embed the addon. capabilities.multiprocessWrite=false.
export function betterSqliteAdapter(opts: { path: string }): DbAdapter;
```

Swapping engines is one factory call at composition time; the executor and stores never see
the concrete type. The single-process **fallback** for the Rust core is `libsqlRustAdapter`
(rusqlite / libSQL Rust crate) — `betterSqliteAdapter` is a Node-only escape hatch, not the
core's fallback, because a Rust core cannot link the `better-sqlite3` Node addon.

---

## 3. Execution, durability, and the background worker

Three orthogonal concerns. **Cross-process write coordination is not one of them** — it is
the engine's, always.

### 3.1 Execution axis (where the fn body runs)

| Mode | Runs on | Use for |
|---|---|---|
| `inline` (default) | the calling thread | almost everything; the engine handles cross-process safety |
| `worker` | a worker thread (Piscina) | CPU-bound relocatable work you want off the main thread |

Each process opens the DB directly through the adapter. There is no `process`/`broker`
*owner* mode and no `auto` promotion: those existed to elect a single write owner, a job the
engine now does. The former `broker` **durable-queue** role survives as durability (§3.2) +
the background worker (§3.3), not as an owner.

### 3.2 Durability axis (does an in-flight effect survive a crash)

| Level | Guarantee | Mechanism | When required |
|---|---|---|---|
| `none` (default) | A single ACID transaction is all-or-nothing. A crash loses only *un-submitted* work. | rely on engine ACID | the mutation fits in ONE transaction (§5.2) |
| `journaled` | An accepted mutation completes even across a crash, exactly once. | outbox/journal row committed in the **same transaction** as the business write + idempotent resume | the mutation spans MULTIPLE transactions (external embed + separate vector store, §5.1) |

Durability is opt-in and composed outside the wrapper: `durable(queued(fn))`. Off by default
because a single-transaction write needs nothing more than engine ACID.

### 3.3 The background worker (the one thing the engine does not give)

The engine coordinates writes across live processes, but a short-lived CLI still exits with
deferred/journaled work outstanding. The **background worker** is an optional participant that
outlives the CLIs to drain that backlog:

```ts
export interface BackgroundOptions {
  /** Attach/spawn a background drainer for this identity. It is a normal multiprocess_wal
   *  participant — NOT an exclusive writer. */
  drain: 'journal' | 'queue' | 'both';
  /** 0 = ephemeral one-shot: drain what's pending, then exit. >0 = linger this long past
   *  idle as a daemon. Same mechanism, one knob. */
  idleMs?: number;
}
```

- In a **long-lived server** (napi frontend), the drainer runs in-process — no separate
  process needed.
- In a **fleet of CLIs**, a `sox-executord` participant is lazily spawned when journaled/queued
  work exists and no long-lived server is present; it drains and idle-exits.
- Because the drainer is just another writer the engine serializes, spawning a second or third
  by accident is **safe** (they contend on the engine's writer slot, they do not corrupt) —
  a stark contrast to the pre-engine world where a duplicate owner was a bug.

### 3.4 Decision matrix

| Consumer situation | execution | durability | background |
|---|---|---|---|
| Long-lived server, in-process only | `inline` | `none` | in-process drainer if journaled |
| Read-heavy consumer (bulk vector reads) | `inline` | `none` | — (route reads to a parallel lane, §7) |
| Fleet of short-lived CLIs sharing one store | `inline` | `none` if single-tx; `journaled` if multi-tx | `sox-executord` if `journaled`/queue |
| CPU-bound transform before a write | `worker` | per above | per above |
| Durable backlog drained later | `inline` producers | `journaled` | `sox-executord` (drain: 'queue') |
| Graph mutation = node+edges only (one tx) | `inline` | `none` (engine ACID suffices, §5.2) | — |
| Graph mutation = node+edges **+ external embedding to a separate vector store** | `inline` | `journaled` (crosses transactions) | drainer completes the vector upsert |

---

## 4. Required invariants (as testable guarantees)

Each guarantee has a test obligation (per repo VERIFICATION.md / DOD.md — a behavioral test
must go red if the invariant is broken; prove concurrency with latches, not `sleep`; trust
exit codes, not stdout).

1. **Engine-coordinated multi-process write safety.** N separate OS processes open one file
   through a `multiprocessWrite` adapter and write concurrently; no corruption, `integrity_check`
   clean, every commit durable, no `SQLITE_BUSY` surfaced to callers (writers block on the
   engine slot and proceed).
   *Test:* spawn N real processes writing the same Turso file; assert row count, integrity,
   and zero caller-visible lock errors. **Negative control:** the same test on a
   `multiprocessWrite:false` adapter must fail/refuse.
2. **Multi-process read snapshot consistency.** A reader in one process sees a consistent
   snapshot and is never invalidated by a writer in another (the engine's guarantee, relied on
   explicitly).
   *Test:* long reader in P1 spanning many commits from P2; assert a stable snapshot.
3. **Single-process lane serialization + backpressure.** Within a process, a `concurrency:1`
   lane serializes; a full lane rejects (or blocks) per `onFull` and never grows unbounded.
   *Test:* saturate a lane; assert ordering and bounded memory.
4. **Idempotency.** A retry with the same `idempotencyKey` returns the original result and
   does not double-write, even across process boundaries (ledger in the DB, §5.3).
   *Test:* submit twice with one key from two processes; assert one row, same result.
5. **Journaled exactly-once.** A crash mid-effect leaves the journal row committed with the
   business write; resume completes it once.
   *Test:* kill a process between tx1 and the external step; a drainer completes the effect
   exactly once on restart; reopen the store to prove persistence.
6. **Background drainer liveness & idle-exit.** A drainer claims work under a lease, re-checks
   the queue under commit before exiting on empty (lost-wakeup safety), and idle-exits at
   `idleMs`; a crashed drainer's lease is reclaimed by the next participant.
   *Test:* barrier an enqueue into the drainer's exit window; assert it is still drained;
   `kill -9` a drainer mid-lease; assert reclaim.
7. **Honest read-your-writes.** `inline` + a synchronous adapter is synchronous
   read-your-writes. With a worker or an async adapter, a read after `await submit` always
   sees the write; a fire-and-forget read may not — stated, never hidden.

---

## 5. Integration with the two real stores

### 5.1 `@adhd/sox-graph-store` — write path and graph atomicity

Read against source (`libs/data/graph/graph-store/src/index.ts`, v0.4.0):

- **PRAGMAs** (`index.ts:17-23`): `journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`, `foreign_keys=ON`, `cache_size=-64000`. Correct, and compatible with
  Turso's WAL-based `multiprocess_wal`.
- **Transaction style:** deferred `db.transaction(() => …)` throughout
  (`index.ts:777,896,998,1007`); it never uses `.immediate()`. Under concurrent writers a
  deferred transaction that reads then upgrades can hit an upgrade conflict. Route the writer
  through `transaction({ immediate: true })` (§2.5) so the adapter issues `BEGIN IMMEDIATE`
  where supported. *(BACKLOG §12.)*
- **Compound node+edges mutation IS single-transaction.** `writeGraph(nodes, edges)`
  (`index.ts:1003-1027`) wraps all node inserts and all edge inserts in one `db.transaction()`;
  likewise `supersede` (`:896`) and `writeNodeBatch` (`:998`). So node+edge atomicity is
  guaranteed by engine ACID — no durability layer needed for it.

**Where atomicity breaks — the vector.** graph-store stores **no embedding vector**; per ADR
0007 D6 vectors live in a separate `@adhd/sox-vector-store` space. A logical "write node with
its embedding" is:

```
tx1 (graph-store):  writeGraph(node, edges)     ← atomic
[external/async]:   embed(content) → float32[]  ← slow, can fail, not transactional
tx2 (vector-store): upsert(nodeId, vector)       ← separate transaction
```

A crash between `tx1` and `tx2` leaves a durable-but-inconsistent graph. **This is the one
place `journaled` is required.** Design target: compute the embedding *before* the write
transaction, then write node+edges(+vector) in one transaction where the engine allows it —
Turso's **native vectors** (`nativeVectors`) can collapse tx1+tx2 into one, removing the gap
entirely (§6.4). Until then, `durable(queued(...))` records "vector pending for node N" in the
same transaction as the node, and the background drainer (§3.3) completes the upsert
idempotently.

### 5.2 The single-transaction test (when do you need `journaled`?)

> **If the whole mutation fits in one transaction on one file, `none` is correct — engine
> ACID + FK constraints give atomicity + durability. If it spans multiple transactions
> (external async call in the middle, or two separate stores), `journaled` is required.**

`journaled` is the DBOS/transactional-outbox pattern: the journal entry commits **in the same
transaction** as the business write, and resume replays it **idempotently**. Build on
**Reflow-ts** (SQLite, "Temporal without a server," CLI-oriented) or **DBOS** rather than
hand-rolling (§9).

### 5.3 `@adhd/sox-task-queue` — absorbed as durable work (USER DECISION 2)

Read against source (`libs/data/queue/task-queue/src/task-queue.ts`):

`@adhd/sox-task-queue` is a durable queue whose role folds into the executor's durability +
background-drain layers. Its mechanisms map straight across (all verified in source):

- **Atomic claim** (`task-queue.ts:429-442`):
  `UPDATE tasks SET status='running',… WHERE id IN (SELECT id … WHERE status IN
  ('queued','scheduled') AND (scheduled_at IS NULL OR scheduled_at<=?) ORDER BY priority DESC,
  created_at ASC LIMIT ?) RETURNING *`.
- **Idempotency ledger** (`:350-395`): `request_ledger` keyed on `client_request_id`,
  `INSERT … ON CONFLICT DO NOTHING`. → invariant #4.
- **Heartbeat leases + reaper** (`:273-324,426`): `lease_expires_at`, re-queue on expiry,
  dead-letter after `5×heartbeatTimeout`. → drainer liveness / reclaim (invariant #6).
- **Backoff** (`backoff.ts`), **worker pool** (`worker-pool.ts`). → lane scheduling.

**Claim semantics under the decided engine.** The atomic claim is correct **because writes
serialize**: only one committer runs the `UPDATE…RETURNING` at a time, so two claimers cannot
take the same row. Turso `multiprocess_wal` **preserves exactly this** — it serializes writers
across processes on the single-writer slot — so the claim ports **unchanged** and multiple
CLI processes (and the background drainer) can all claim from the same queue safely, with no
elected owner. **Do not enable MVCC (`BEGIN CONCURRENT`) for the queue:** MVCC would let two
claimers read the same snapshot and conflict-abort at commit (the current code throws on any
dequeue error, `:443-444`, with no conflict-retry path) and is mutually exclusive with
`multiprocess_wal` anyway (§6.2). Serialized multi-process claiming is the correct model.

### 5.4 Migrating the stores onto the `DbAdapter` seam

Both stores currently hardwire better-sqlite3: `createGraphBackend(db: Database.Database)`
(`index.ts:1531`, ctor `:684`) and the task-queue open a concrete `better-sqlite3` connection.
To make the engine pluggable (and reach Turso `multiprocess_wal`) without a rewrite:

1. **Widen the factories** to accept a `DbAdapter`/`DbConnection`:
   `createGraphBackend(adapter: DbAdapter)`. `tursoAdapter({ multiprocessWal:true })` (the
   Rust core via napi) is the V1 multi-process path; `betterSqliteAdapter` remains only for the
   single-process pure-TS escape hatch.
2. **Keep `GraphBackend` as-is** — it is already the right store-level abstraction; the
   adapter sits below it, so its API is untouched, only its constructor input widens.
3. **Route the writer through `transaction({ immediate: true })`**, closing the deferred-upgrade
   hazard (§5.1) on every engine that supports it.
4. **The connection is async through the Rust core.** Because V1's core is Rust and the
   `DbConnection` crosses napi (§2.4), the connection the widened `createGraphBackend` receives
   is **asynchronous**. graph-store's write methods therefore gain an async form when built over
   a napi/Turso adapter (the executor boundary is already `Promise`-based, §2.2, so this
   composes). The synchronous `better-sqlite3` code path survives **only** on the pure-TS
   `betterSqliteAdapter` escape hatch, unchanged, for single-process consumers. This async
   migration of graph-store's write surface is the real integration cost of a Rust core and is
   sized in P1 (§8).

Additive and back-compatible (the concrete-connection overload can remain, deprecated).
**BACKLOG §12.**

---

## 6. Storage engine — Turso `multiprocess_wal` is the backbone (VERIFIED)

### 6.1 The two distinct questions

Q-A: *Does any embedded engine give safe **multi-process writes** — many OS processes writing
one file without corruption?*
Q-B: *Does any embedded engine give **multi-process PARALLEL writes** — those writes committing
genuinely concurrently, not serialized?*

### 6.2 VERIFIED answers (primary sources)

**Q-A — YES. Turso `multiprocess_wal` provides safe multi-process writes today.** Enabled via
`dsn?experimental=multiprocess_wal` (shipped v0.6.0, May 2026): "several processes can open the
same `.db` file concurrently and coordinate WAL reads, writes, and checkpoints through a shared
memory file" (`.tshm`, coordinated by OFD locks on Linux / fcntl on macOS). It is genuinely
coordinated: "A reader in one process cannot be invalidated by a writer in another.
Checkpointing is serialized across processes… Each read transaction observes a consistent
snapshot, even if a concurrent process commits new frames." Writers serialize safely: "Writers
are serialized across processes. At any instant, at most one process… holds the writer slot,
and writers in other processes **block** until it is released." This is the mechanism this
spec adopts as its cross-process write coordinator.
  *Sources:* `docs.turso.tech/sql-reference/multiprocess-access`, `turso.tech/blog/turso-0.6.0`.

**Q-B — NO. Writes serialize; there is no parallel multi-process write.** Parallel writes
require MVCC (`BEGIN CONCURRENT` / `PRAGMA journal_mode='mvcc'`), which is single-process only,
still beta ("not recommended for production use"; eagerly loads the whole DB into memory on
first access; only `wal_checkpoint(TRUNCATE)` supported) and **mutually exclusive** with
`multiprocess_wal` ("`BEGIN CONCURRENT` is not supported with multi-process right now… use
either MVCC within a single process or multi-process WAL, not both"). (Indexes under MVCC,
once unsupported, work from Turso v0.4.0+ — so the schema is not the blocker; single-process +
mutual-exclusivity + beta are.)
  *Sources:* `docs.turso.tech/sql-reference/multiprocess-access`,
  `github.com/tursodatabase/turso/blob/main/docs/manual.md`,
  `turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes`.

Serialized-but-safe multi-process writes are exactly what the write-serialization law (§1.2)
needs. Parallelism is not required and is not pursued.

### 6.3 Maturity and constraints

Turso Database "powers production applications today at multiple organizations, including
Turso Cloud, the Kin AI assistant, and Spice.ai," and has "not yet reached 1.0… some features
are explicitly marked experimental" (independent backups recommended until 1.0).
`multiprocess_wal` specifically is experimental — "the on-disk coordination format and public
API may change between releases. Do not rely on the format for long-term storage across Turso
versions" — and **64-bit Unix only** (Linux/macOS/Android; no Windows).
  *Sources:* `github.com/tursodatabase/turso` README, `docs.turso.tech/sql-reference/multiprocess-access`.

libSQL (the C fork) and its Rust crate have **no** `multiprocess_wal` and no MVCC — they
inherit SQLite's single-writer model. Turso Database is the only engine providing the
coordinated multi-process story.

### 6.4 Why this fits the executor

- **It IS the coordinator.** The engine's single-writer slot serializes committers across
  processes, so the executor needs no owner election, no application-level write funnel, and no
  executor-managed lock file — cross-process coordination is the engine's own shared-memory
  layer (`.tshm` + OFD/fcntl locks), below the application. Every process opens the DB directly;
  the architecture collapses to "open through the adapter and write."
- **Async I/O** → the napi frontend runs DB work off the JS event loop.
- **Native vectors** → collapse the graph node + embedding cross-transaction gap (§5.1) into a
  single transaction, retiring the one `journaled` case.
- **Reader snapshots** → honest cross-process read-your-writes semantics (invariant #2).

### 6.5 The adapter contract enforces the safety boundary

Every engine is a `DbAdapter` (§2.5). The `multiprocessWrite` capability is the safety gate:

- `tursoAdapter()` → `multiprocessWrite: true`. **Default backbone** (the JS adapter enables
  `multiprocess_wal` at connect time without an explicit flag). Multiple processes may open and
  write safely.
- `betterSqliteAdapter` / `libsqlRustAdapter` → `multiprocessWrite: false`. Single-process
  only: opening the same identity from a second process is **rejected at connect time** (or
  downgraded to an explicit, logged single-process lock), never silently unsafe. These are the
  **Windows / zero-experimental-risk fallback** for single-process deployments.

The executor asserts the capability against the deployment: a multi-process consumer that
passes a `multiprocessWrite:false` adapter fails loudly.

### 6.6 Accepted risk and mitigations (owner decision)

Adopting an experimental engine feature as the backbone is a deliberate, owner-made decision.
The JS-side adapter (`@adhd/sox-store-adapter`) already ships `multiprocess_wal` enabled by
default across all consumers — so the risk profile is now operational (proven in daily use)
rather than theoretical. Mitigations, all mechanized:

1. **Pin the Turso version** and treat `multiprocess_wal`'s on-disk format as version-locked;
   gate upgrades on the multi-process integrity test (invariant #1).
2. **Independent backups** via `VACUUM INTO` on a schedule (ADR 0007 D6 precedent) until Turso
   1.0, since the maintainers advise it.
3. **The fallback adapter is real, not theoretical:** `libsqlRustAdapter` (rusqlite / libSQL
   Rust crate) keeps the single-process path working from the Rust core with zero experimental
   surface, so a Turso regression degrades to single-process rather than to broken; the pure-TS
   `betterSqliteAdapter` covers a Node consumer that does not embed the core.
4. **CI runs the N-process multi-write suite by default** (VERIFICATION.md standard) on
   64-bit Unix, so a `multiprocess_wal` behaviour change is caught on first commit.

---

## 7. FFI / large-payload boundary + claim-check

Crossing Rust↔JS (napi) serializes and copies the payload.
- **Cheap for tiny writes** — a node insert is a few hundred bytes.
- **Real for bulk vector reads** — a 1536-dim `float32` vector ≈ 6 KB; 1000 results ≈ 6 MB per
  call.

Mitigations:
1. **Claim-check.** For durable/queued work, journal and return the vector's **id**, not the
   blob; the consumer fetches by id on a read path.
2. **Reads bypass the write concerns.** WAL/`multiprocess_wal` give lock-free concurrent
   readers across processes; give reads a parallel lane or open a `readonly` connection through
   the adapter (ADR 0007 D2). Reads never touch the writer slot.
3. **Keep the boundary write-shaped.** Large reads should not be funnelled through the napi
   write API.

---

## 8. Phased delivery — de-risk the coupled bets

**V1 is Rust (owner decision) — the language is fixed from the first commit, not staged.**
The de-risking that remains is over **engine** and **model**: no single phase changes the
engine *and* the model at once. P0 stands up the Rust core + napi + Nx Rust toolchain over a
single-process engine to prove the core; P1 turns on Turso multi-process; later phases add
durability and engine features. The Rust toolchain and a Rust Turso binding are therefore
**V1 prerequisites**, not P3 concerns (§11).

| Phase | Deliverable | Axis changed | Proof / gate |
|---|---|---|---|
| **P0 — Rust core + napi + adapter seam** | `sox-executor-core` (Rust) + the **napi addon**; the Nx Rust/napi build toolchain (§11); `DbAdapter` (§2.5) with `libsqlRustAdapter` (single-process) first; `queued` (lanes, backpressure, idempotency, honest async); graph-store/task-queue factories widened to the async adapter (§5.4). | Rust core + adapter seam (single-process engine) | Invariants #3,#4,#7 green against the Rust core via napi; graph-store routed through the async adapter; a second adapter stub proves the seam; the addon loads as a real consumer would. |
| **P1 — Turso multi-process backbone** | `tursoAdapter()` (Rust turso binding, multiprocess_wal enabled by default matching the JS adapter); capability gate (§6.5) + accepted-risk mitigations (§6.6); async migration of graph-store's write surface (§5.4). | engine (adds multi-process) | Invariants #1,#2 green: N real processes write one Turso file concurrently, integrity clean, zero caller-visible lock errors; negative control on a single-process adapter refuses. |
| **P2 — durability + background drainer** | `durable(journaled)` + `sox-executord` drain participant (§3.3); absorb task-queue's claim/ledger/lease as durable work over the engine (§5.3). | durability | Invariants #5,#6 green: crash → exactly-once resume; drainer idle-exits; `kill -9` lease reclaim; parity vs task-queue's suite. |
| **P3 — native vectors (gated on Turso feature stability)** | Move the embedding into the graph transaction via Turso `nativeVectors`, retiring the §5.1 `journaled` case. | engine feature | node+vector in one tx; the cross-tx gap closes; `journaled` no longer required for the embed path. |

P0+P1 deliver the headline win — safe multi-process writes with **no daemon, no election** —
in Rust from the start. `libsqlRustAdapter` (P0) remains the permanent single-process fallback
(§6.6). The largest V1 unknowns are front-loaded: the Nx Rust/napi toolchain and a Rust-side
Turso `multiprocess_wal` binding (§11) — these gate P0/P1, so they are resolved before any
feature work rather than discovered late.

---

## 9. DRY / prior-art evaluation (build on vs build)

| Concern | Build on (verified prior art) | Verdict |
|---|---|---|
| Multi-process write coordination | **Turso `multiprocess_wal`** (the engine) | **Adopt** — this is the backbone; do not hand-build owner election. |
| In-process scheduler / lanes | Tokio semaphores / `tokio::sync` (Rust); `p-queue`/`p-limit`/`async-mutex` as the conceptual model | **Build on** Tokio primitives in the Rust core; the JS libraries are the reference semantics, not a dependency. |
| Worker execution | **Piscina** | **Build on** for `execution: 'worker'`. |
| Rust→Node addon | **napi-rs** | **Build on** — SWC/Biome/Turbopack/Prisma precedent. |
| Ergonomic RPC stubs | **Comlink** | **Evaluate** for the worker frontend; not core. |
| Durable journaling / workflow | **DBOS** (same-transaction outbox) / **Reflow-ts** (SQLite, CLI-oriented) as the model | **Study the pattern** — the journal/resume is implemented in the Rust core (same-transaction outbox + idempotent replay); these TS/JS engines are the reference design, not a linked dependency. |
| Durable queue (claim/backoff/ledger/lease) | **`@adhd/sox-task-queue`** (in-repo) | **Reuse / absorb** as durable work (§5.3). |
| Graph write path | **`@adhd/sox-graph-store`** (in-repo) | **Reuse** — hosted over the adapter, never reimplemented. |
| DB engine adapter | in-repo **`GraphBackend`/`GraphBackendCapabilities`** idiom (`index.ts:328,1531`) | **Extend the idiom** to the engine boundary (§2.5) — don't invent a new abstraction style. |
| Idle-drain daemon lifecycle | systemd socket-activation; **nx/turbo daemon**; git fsmonitor | **Study** — the drainer's idle-exit is small; the harder single-owner election is no longer needed. |

Net: the executor's novel surface shrank once the engine took over coordination — the
`queued`/`durable` wrappers, the in-process lane scheduler, the journal/resume, the optional
idle-drain participant, and the two Rust frontends. Cross-process coordination is bought, not
built.

---

## 10. Open questions — resolutions

| # | Question | Resolution | Basis |
|---|---|---|---|
| Q1 | Cross-process write coordination: owner-elected or engine? | **Engine (Turso `multiprocess_wal`).** No elected owner, no application-level write funnel; coordination is the engine's `.tshm` shared memory + OFD/fcntl locks. | OWNER DECISION (2026-07-23): fully adopt multi-process. VERIFIED safe (§6.2). |
| Q2 | v1 language: TS or Rust? | **Rust from V1.** The core crate + adapters are Rust from the first commit; the napi addon is the V1 Node artifact; there is no TypeScript core. | OWNER DECISION (2026-07-23): V1 not in TypeScript. Fixes the language up front; de-risking (§8) now stages only engine + model. Elevates the Nx Rust toolchain + a Rust Turso binding to V1 prerequisites (§11). |
| Q3 | Durability: core opt-in or later? | **In the core as opt-in `durable(...)`, P2**, OFF by default. | node+edges is single-tx (§5.1-5.2); only the external-embed/separate-vector case needs it — and Turso native vectors (P3) can retire even that. |
| Q4 | Default engine | **`tursoAdapter()`** (Rust, multiprocess_wal enabled by default); `libsqlRustAdapter` is the Rust single-process fallback; `betterSqliteAdapter` is a pure-TS single-process escape hatch. (The JS adapter `@adhd/sox-store-adapter` already enables `multiprocess_wal` by default.) | Turso is the only engine giving safe multi-process writes (§6.2); the adapter's `multiprocessWrite` gate makes the fallback explicit and safe (§6.5); a Rust core cannot link the better-sqlite3 Node addon (§2.5). |
| Q5 | Package placement | `libs/data/executor/executor` → `@adhd/sox-executor` (tags `type:lib`, `area:data`, `group:executor`, `platform:node`). Rust: `crates/sox-executor-core`; `sox-executord` as an `apps/` (or `bin/`) member. | Matches repo layout (`libs/<area>/<group>/<name>`, `@adhd/sox-*`). |
| Q6 | How is the engine chosen? | **Behind a capability-flagged `DbAdapter` (§2.5), always** — one factory call at composition time; the executor and stores never name a driver. | USER DIRECTIVE (2026-07-23): keep the adapter pattern for DBs; extends the in-repo `GraphBackend` idiom to the engine boundary. |
| Q7 | Role of `sox-executord` daemon | A **background-drain participant**, not a write owner — spawned only for deferred/queued work after CLIs exit; safe to over-spawn (engine serializes it). | Consequence of Q1: with engine coordination, the daemon is no longer the write gatekeeper (§3.3). Refines USER DECISION 1's daemon rationale. |
| Q8 | Parallel writes via MVCC (`BEGIN CONCURRENT` / `journal_mode='mvcc'`)? | **No.** `multiprocess_wal` (serialized, multi-process) is retained; MVCC is not used. | OWNER DECISION (2026-07-23): MVCC is single-process and mutually exclusive with `multiprocess_wal` (§6.2); adopting it would reintroduce a single owner + IPC for the CLI fleet and depend on a beta engine mode. Multi-process direct-open with serialized writers is preferred over write parallelism. |

### User decisions
- **USER DECISION 1 (Rust core + two frontends): honoured, Rust from V1.** The core crate is
  Rust from the first commit (§2.4), shipped as the napi addon, with the `sox-executord` daemon
  as the second frontend. The daemon's role is refined from write-owner to background-drain
  participant (Q7), a direct consequence of adopting engine coordination.
- **USER DECISION 2 (absorb the task-queue): upheld.** Its claim/ledger/lease fold into the
  durability + background-drain layers and port unchanged under `multiprocess_wal`'s serialized
  writers (§5.3). Do not enable MVCC for the queue.
- **USER DECISION 3 (Rust + Turso family): upheld and now central.** Turso `multiprocess_wal`
  is the backbone; native vectors and async I/O are on the roadmap (P3, §6.4).
- **OWNER DECISION (2026-07-23): fully adopt multi-process.** Turso's engine-level
  coordination is the cross-process write model; single-owner election is not built. The
  experimental-format risk is accepted with the §6.6 mitigations.
- **OWNER DECISION (2026-07-23): serialized multi-process over MVCC parallelism (Q8).**
  `multiprocess_wal` is retained; `BEGIN CONCURRENT`/MVCC is not adopted, since it is
  single-process, mutually exclusive with `multiprocess_wal`, and would reintroduce the owner
  process it was chosen to eliminate.

---

## 11. VERIFIED vs UNVERIFIED / assumptions

### Verified (primary sources or in-repo source)
- **Turso `multiprocess_wal` provides safe multi-process writes** (many processes open one
  file, coordinated via `.tshm` shared memory + OFD/fcntl locks; readers never blocked by
  writers; consistent cross-process snapshots; writers serialized on a single-writer slot,
  blocking not corrupting); **experimental** (format/API may change; not for long-term storage
  across versions); **64-bit Unix only**. Enabled **by default** in the JS adapter
  (`@adhd/sox-store-adapter` `createTursoAdapter()`) — every consumer gets it without an
  explicit flag. — `docs.turso.tech/sql-reference/multiprocess-access`,
  `turso.tech/blog/turso-0.6.0` (verified via live domain-restricted search, 2026-07-23).
- **No multi-process PARALLEL writes:** MVCC (`BEGIN CONCURRENT`) is single-process +
  experimental and mutually exclusive with `multiprocess_wal`. —
  `github.com/tursodatabase/turso/blob/main/docs/manual.md`,
  `turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes`.
- **Turso maturity:** pre-1.0, production-used (Turso Cloud, Kin AI, Spice.ai), some features
  experimental; backups advised until 1.0. — `github.com/tursodatabase/turso` README.
- **libSQL (C fork + Rust crate):** no `multiprocess_wal`, no MVCC; inherits SQLite
  single-writer. — `github.com/tursodatabase/libsql` README.
- **`@adhd/sox-graph-store` write path:** PRAGMAs (`index.ts:17-23`); deferred transactions,
  no `.immediate()` (`:777,896,998,1007`); node+edges is one transaction via
  `writeGraph`/`supersede`/`writeNodeBatch` (`:1003-1027,896,998`); stores no embedding vector;
  `createGraphBackend(db)` hardwires `Database.Database` (`:684,1531`).
- **`@adhd/sox-task-queue`:** atomic `UPDATE…RETURNING` claim ordered `priority DESC,
  created_at ASC` (`task-queue.ts:429-442`); `request_ledger` idempotency (`:350-395`);
  heartbeat lease + reaper (`:273-324,426`); dequeue errors thrown, no conflict-retry path
  (`:443-444`). Claim correctness depends on serialized writers — preserved by
  `multiprocess_wal`.
- **Rust-engine-from-TS via native addon is production-normal** (napi-rs; SWC/Biome/Turbopack/
  Prisma).
- **Repo conventions:** ADRs in `docs/decisions/NNNN-*.md`; specs in `docs/spec/`; packages at
  `libs/<area>/<group>/<name>` named `@adhd/sox-*` with `type:/area:/group:/platform:` tags;
  no Rust/napi package precedent exists yet (no `Cargo.toml`/`*.node`/`build.rs` outside
  `node_modules`).

### Unverified / assumptions (validate before build)
- **No Nx Rust/napi build integration exists yet — and it is a V1 (P0) prerequisite** now that
  the core is Rust from the first commit. First-of-its-kind toolchain (`@monodon/rust` and/or a
  napi-rs Nx executor + prebuilt-binary distribution). Must be resolved before P0 feature work.
  BACKLOG.
- **A production-grade Rust Turso `multiprocess_wal` binding — a V1 (P1) prerequisite.** The JS
  addon `@tursodatabase/database` is verified, but V1's core is Rust, so a Rust-side
  `multiprocess_wal` API at the required maturity is on the critical path (not deferrable to a
  later phase). Confirm before P1; if unavailable, P1 slips or the core temporarily wraps the
  Turso C API directly. This is the single largest V1 unknown.
- **Turso `nativeVectors` sharing one transaction with graph rows** (P3, §6.4) assumes vector
  and node writes commit together at the needed maturity — verify when P3 is scheduled.
- **Reflow-ts / DBOS fit for the `journaled` layer** is a recommendation to evaluate; APIs not
  read this session.
- **Writer-slot contention budget** under a large CLI fleet (how long writers block on the
  engine slot at the p99 fleet size) needs a measured budget in P1.

---

## 12. BACKLOG items this spec raises

File to repo `BACKLOG.md` on acceptance (dedupe against existing entries first):
1. **graph-store deferred transactions** — writers use deferred `db.transaction()`, never
   `.immediate()` (`index.ts:777,896,998,1007`); route the writer through
   `transaction({ immediate: true })` via the adapter (§5.1, §5.4).
2. **task-queue dequeue has no conflict-retry path** (`task-queue.ts:443-444`) — correct under
   serialized writers (SQLite / `multiprocess_wal`); do not enable MVCC for the queue (§5.3).
3. **No Nx Rust/napi build integration** — greenfield toolchain, now **V1 (P0)-blocking** since
   the core is Rust from the first commit (§11).
4. **graph node + embedding vector cross-transaction gap** (§5.1) — needs `journaled`; retired
   permanently by Turso `nativeVectors` (P3).
5. **graph-store + task-queue hardwire `better-sqlite3` `Database.Database`**
   (`index.ts:684,1531`) — widen factories to accept a `DbAdapter` (§2.5, §5.4); through the
   Rust core the connection is async (§5.4), so graph-store's write surface gains an async form.
   Enables the Turso `multiprocess_wal` backbone. Additive/back-compatible.
6. **Confirm a Rust-side Turso `multiprocess_wal` binding** at required maturity — **V1
   (P1)-blocking**, the largest V1 unknown (§11 assumptions).
