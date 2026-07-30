# Ecosystem Integration Features

## Purpose

The sox-ecosystem data packages (`@adhd/sox-graph-store`, `@adhd/sox-blob-store`,
`@adhd/sox-embedding-provider`, `@adhd/sox-vector-store`, `@adhd/sox-hybrid-search`,
`@adhd/sox-ingest`, `@adhd/sox-claim-verification`, `@adhd/sox-analysis`) were built as
a generalized RAG substrate. Several of these packages have real, production consumers
in the memory system. Others — `blob-store`, `claim-verification`, and parts of `ingest`
and `hybrid-search` — were built but have not yet been integrated into a live consumer
(see BACKLOG.md BL-166).

This document catalogs feature requests from the first substantial external consumer of
these packages: the Approved Source Platform (an agent tool-selection and documentation
search system). Each entry includes a generalized example showing why the capability is
broadly useful — because none of these features are consumer-specific. They are generic
infrastructure that any RAG system, document pipeline, or background-processing consumer
would need.

No hard recommendations are made about where code should live. Some of these features may
be extensions to existing packages; others may be new packages. The examples are intended
to clarify what the feature does, not to prescribe an implementation home.

---

## 1. `@adhd/sox-ingest` — Document Preparation Pipeline

> **Status:** `private: true`. Used only for its extractive summary. Has heading chunkers (real)
> and an AST chunker (regex stub — BL-115). Backlog: BL-165 (consolidate), BL-115 (fix AST chunker),
> BL-117 (late chunking no-op).

### 1.1 Heading-Aware Chunking

Chunk documents by their heading structure rather than by fixed token windows. A markdown file
with sections `## Installation`, `## Usage`, `## API Reference` should produce three chunks, each
tagged with its heading path.

**Generalized example:** Any RAG system ingesting documentation, wikis, or structured prose benefits
from heading-aware chunks. Embedding a section at a time (rather than a random 500-token window)
gives much better semantic precision on retrieval, and the heading metadata enables hierarchical
context expansion (parent section pulls in child sections).

### 1.2 Code AST Chunking (Fix BL-115)

Chunk source code files at function, class, and method boundaries using tree-sitter AST parsing,
not regex heuristics. Never split a function across chunks. Support TypeScript, Python, Java, C#
as primary targets.

**Generalized example:** Any system that indexes code repositories for semantic search needs
function-level chunking. Retrieving a complete function is much more useful than retrieving half
of it; tree-sitter-backed parsing is the only reliable way to find those boundaries.
(Reference: cAST algorithm, arXiv 2506.15655 — AST-aware chunking is never worse than sliding
window and produces 1.8–5.5 Pass@1 gains.)

### 1.3 File-Type Normalizers

Produce canonical text from source files before chunking. Normalization steps per format:
- Markdown/MDX: strip HTML, unify code-fence styles, collapse heading whitespace
- RST: strip role markers, unify section underlines
- AsciiDoc: strip attribute entries, unify list markers
- Source code: pass-through with optional comment stripping
- Plain text: normalize line endings, collapse whitespace

**Generalized example:** Normalization is a prerequisite for content-hash-based dedup. Two
repositories storing the same README with different whitespace or a trailing newline should
produce the same normalized content hash. Every document-ingestion pipeline needs this step.

### 1.4 Matcher Registry + Engine

A glob-based file selection engine that operates over manifest file trees. `register`→`seal`→`get`
pattern. Built-in matchers: `readme-only`, `docs`, `docs-and-examples`, `all-docs`, `only-code`,
`all-text`. Supports include/exclude globs, file type allowlists, max files/bytes, binary
detection, `.gitignore` and `.tool_searchignore` stacking.

**Generalized example:** Any consumer that ingests from SCM or filesystem needs to select *which*
files to process. A reusable matcher engine decouples that selection logic from both the source
provider (GitHub, Bitbucket, FS) and the ingestion pipeline (chunker, embedder). The same matcher
config can be used across code repositories, documentation sites, and local directories.

### 1.5 Public Availability (Fix BL-165)

Make `@adhd/sox-ingest` public by flipping `private: false`. Consolidate the duplicate chunking
and content-hashing code currently scattered across `memory-server` and `memory-core` into this
package so it earns its LOC and has real consumers. Chunk-boundary and hash parity must be
verified during consolidation so recall and dedup don't shift.

**Generalized example:** A document-preparation library is useless if it's private. External RAG
consumers need a canonical ingest pipeline. The five public data packages
(`@adhd/sox-embedding-provider`, `@adhd/sox-vector-store`, `@adhd/sox-graph-store`,
`@adhd/sox-hybrid-search`, `@adhd/sox-analysis`) form a buildable RAG substrate; `@adhd/sox-ingest`
is the missing document-prep layer that completes it.

---

## 2. `@adhd/sox-source-provider` — SCM Manifest and Content Abstraction (New)

> **Status:** Does not exist as a package. A basic interface is described in the ingest enhancement
> draft but deserves a standalone package to avoid coupling ingest to SCM dependencies like
> `@octokit/rest`.

### 2.1 Source Provider Interface

A generic abstraction over "give me the file tree and content for this reference." Methods:
`fileTree(ref, path?) → FileEntry[]` and `content(ref, path?) → string`. The provider is selected
automatically from the reference's URL scheme (`github.com`, `bitbucket.org`, `local:`).

**Generalized example:** Any consumer that works with files from multiple origins — code repos,
documentation archives, local workspaces — needs to treat them uniformly. Writing `if`-chains
for GitHub vs Bitbucket vs local filesystem in every consumer duplicates logic and misses edge
cases. A provider interface encapsulates each origin's API differences behind a common facade.

### 2.2 GitHub Provider

GitHub implementation using `@octokit/rest`. Gets file trees via the Git Trees API (recursive,
with truncation fallback to Contents API). Gets raw content via Contents API or blob URL. No
cloning. Token-based authentication.

**Generalized example:** Many tools need to list and read files from GitHub repositories without
cloning them — documentation generators, code search engines, CI pipelines, migration scripts.
The Git Trees API returns a full recursive file tree in one call, which is orders of magnitude
faster than cloning or walking the Contents API directory by directory.

### 2.3 Bitbucket Provider

Bitbucket implementation via direct REST (`api.bitbucket.org/2.0/repositories/{ws}/{repo}/src`).
Same capabilities as the GitHub provider: file tree listing and raw content fetch. No discovery
or search (Bitbucket search is not needed; explicit references only).

**Generalized example:** Organizations using Bitbucket have the same need as GitHub users: read
file trees and content from repos without cloning. The REST API surface is different but the
consumer-facing abstraction is identical.

### 2.4 Local Filesystem Provider

Implementation using `fs`, `fast-glob`, and the `ignore` package (kaelzhang/node-ignore).
Recursive directory scanning with gitignore-aware filtering, configurable excludes, and SHA-256
content hashing for change detection.

**Generalized example:** Any tool that indexes local files — code search, documentation generators,
project analysis — benefits from a standardized manifest representation that mirrors what remote
providers return. A file is a file whether it lives on GitHub, Bitbucket, or `/Users/kyle/src/`.

### 2.5 Provider Registry

A registry that maps URL schemes to provider factories. `registerProvider('github', () =>
new GitHubProvider(token))`, then `getProvider('https://github.com/owner/repo')` returns the
correct provider. Consumers never import SCM-specific packages directly.

**Generalized example:** Plugin-style provider registration enables third-party consumers to add
custom source types (GitLab, Gitea, AWS CodeCommit, SharePoint) without modifying the core
abstraction. The registry is the extensibility point.

### 2.6 Fake Provider (Test Fixture)

An in-memory provider with configurable file trees and content. Returns the same `FileEntry[]`
and content shape as real providers. Used by integration tests for matchers, chunkers, and
orchestration without network calls.

**Generalized example:** Every test suite that exercises file ingestion or manifest processing
needs a controllable fixture. Network-dependent tests are flaky and slow. A fake provider makes
the entire pipeline testable in milliseconds.

---

## 3. `@adhd/sox-task-queue` — SQLite-Backed Durable Task Queue (New)

> **Status:** Does not exist as a package. The memory-core `WriteQueue` is write-specific and
> serial. No production-ready SQLite-backed task queue exists on npm.

### 3.1 Durable Task Persistence

Tasks stored in SQLite with WAL mode. Survive process crashes. Table: `id, type, status,
priority, payload, retry_count, max_retries, scheduled_at, created_at, started_at, completed_at,
error`. Status machine: `queued → running → completed | failed | dead`.

**Generalized example:** Any background processing system needs a durable queue. If the process
crashes mid-task, enqueued but unprocessed work must survive. SQLite is the simplest embedded
option — no Redis, no DB server, just a file. This is the right choice for CLI tools, edge
services, and developer machines.

### 3.2 Worker Pool with Heartbeat

Configurable concurrency. Workers lease tasks atomically with a heartbeat timeout. If a worker
crashes (heartbeat expires), the task is re-queued for another worker. Stale leases are detected
and recovered.

**Generalized example:** Without heartbeating, a crashed worker leaves its task in `running` state
forever, blocking progress. Heartbeats plus a configurable timeout enable self-healing —
another worker picks up the task after the lease expires. This is standard in job queues (Sidekiq,
Bull, Celery) and equally necessary in embedded queues.

### 3.3 Priority Ordering

Higher-priority tasks are dequeued before lower-priority ones. Tasks at the same priority are
FIFO within that priority level. Priority is set at enqueue time.

**Generalized example:** Not all background work is equally urgent. A live search should jump
ahead of a scheduled catalog refresh. Priority ordering lets urgent tasks skip the line without
needing a separate queue.

### 3.4 Retry with Exponential Backoff

Configurable max retries, base delay, and jitter. Failed tasks are re-queued with a
`scheduled_at` calculated as `now + delay`. After max retries, the task moves to `dead`
(dead-letter state).

**Generalized example:** Transient failures (rate limits, network timeouts, temporary file
conflicts) should be retried automatically. Permanent failures should surface diagnostically
without clogging the queue. Exponential backoff prevents thundering herds on recovery.

### 3.5 Cron-Style Scheduling

Recurring tasks scheduled via cron expressions. The scheduler persists its configuration in the
SQLite database so schedules survive restarts. Uses `node-cron` or `croner` as the cron-parser
backend.

**Generalized example:** Scheduled maintenance — cache refresh, re-embedding, catalog updates,
data compaction — is a universal need. A cron-integrated queue means recurring work uses the
same persistence and worker pool as one-off tasks, rather than requiring a separate scheduler.

### 3.6 Task Lifecycle Hooks

Optional callbacks: `onComplete(task)`, `onFail(task, error)`, `onRetry(task, attempt)`.
Useful for logging, metrics, and cascade triggers (enqueue a follow-up task when a parent
completes).

**Generalized example:** Observability and workflow chaining both benefit from hooks. Log
completion for dashboards, trigger downstream tasks on success, alert on permanent failure.
Hooks keep the queue generic while enabling consumer-specific behavior.

---

## 4. `@adhd/sox-vector-store` — Vector Storage

> **Status:** `SqliteVectorBackend` is production (consumed by memory-core). `LanceDbVectorBackend`
> is in-memory only (BL-114). No `embedAndAggregate` helper exists.

### 4.1 Real LanceDB Backend (Fix BL-114)

Replace the `InMemoryLanceTable` stub with real `@lancedb/lancedb` connections. Support HNSW
and IVF-PQ ANN indexes, configurable per-space. The factory (`openLanceDbVectorStore`) creates
a real LanceDB table at the configured path with the specified index type.

**Generalized example:** Below ~50K vectors, sqlite-vec brute-force is fast enough (and simpler).
Above that, LanceDB's IVF-PQ index provides ~280× speedup (6ms vs 1.7s at 100K vectors on M2 Pro).
Any consumer reaching catalog-scale needs the LanceDB option. The adapter pattern
(`VectorBackend` interface) means callers don't care which backend is in use.

### 4.2 chunk→doc→repo Aggregation Helper

A stateless function: `embedChunkAndAggregate(provider, chunks) → { chunkVecs, docVec }`.
Embeds each chunk, mean-pools chunk vectors to produce a document-level vector. Optionally
mean-pools document vectors to produce a repo-level vector. Does NOT write to the store — it
just produces vectors for the caller to upsert.

**Generalized example:** Hierarchical embeddings (chunk → document → collection) are standard
in RAG: retrieve at chunk level for precision, rank at document level for context, filter at
collection level for scope. Every consumer implementing this does the same math; it should be
a shared utility.

---

## 5. `@adhd/sox-hybrid-search` — Cross-Encoder Reranker

> **Status:** The cross-encoder subpath exists but returns token-overlap scores, not real ONNX
> inference (BL-116). The shared ONNX worker infrastructure is in place (RS-2 completed).

### 5.1 Real Cross-Encoder Reranker (Fix BL-116)

Replace the token-overlap heuristic with a real cross-encoder ONNX model running in the shared
`embedWorker.ts`. Mode: `always-on` / `threshold-gated` / `skip`. Threshold-gated only reranks
when the top-1 hybrid RRF score is below a configurable threshold. Capped at 50 candidates (O(n²)
in cross-encoder). Models: MiniCheck (flan-t5-large, primary), `cross-encoder/nli-deberta-v3-base`
(accuracy), `cross-encoder/nli-MiniLM2-L6-H768` (throughput).

**Generalized example:** RRF hybrid search alone scores ~0.695 Recall@5. Adding a cross-encoder
reranker lifts this to ~0.816 (+17.4%). For high-precision use cases — legal, medical, financial
retrieval — that gain is significant. The cross-encoder is an optional refinement step, not a
core dependency; systems that don't need it can skip it.

---

## 6. `@adhd/sox-graph-store` — Event/Session/Trace Layer

> **Status:** Graph-store has nodes, edges, FTS5, namespaces, supersession chains. No convenience
> API for event recording, session creation, or timeline queries exists.

### 6.1 Event Recording Convenience

A method `recordEvent(sessionNodeId, eventType, payload) → nodeId` that creates a child node
(time-ordered under a session), sets its namespace, and writes an edge to the session. The event
type is a string discriminator; consumers define their own types.

**Generalized example:** Observability systems need to record what happened, when, and in which
context. The session→events pattern is universal: a test run records test events, a search session
records query events, a build pipeline records step events. Graph-store's node+edge model is
well-suited to this; it just needs the convenience method.

### 6.2 Timeline Query

`getTimeline(sessionId, { eventTypes?, from?, to?, limit? }) → Event[]`. Filtered, ordered,
time-bounded retrieval of events within a session namespace.

**Generalized example:** "Show me all errors from this session in the last hour" or "what queries
were issued during this search session" are universal needs. A timeline method that filters by
event type, time range, and count makes graph-store a general-purpose audit store.

### 6.3 Subgraph Assembly for Trace Packets

`getTracePacket(sessionId) → { session, events, claims, sources }`. Assembles all connected
nodes under a session root up to a configurable depth. Returns structured data suitable for
serialization as a trace/audit packet.

**Generalized example:** After an agent produces output, you need to produce an audit packet
showing which sources were accessed, which claims were registered, and which tools were called.
This is the subgraph under a session. The assembly logic is the same regardless of whether the
domain is engineering tool search, legal citation verification, or financial model governance.

---

## 7. Additional Cross-Cutting Features

These are not tied to a single package but emerge across multiple packages.

### 7.1 Structured Error Taxonomy with Codes

Every ecosystem error should carry a machine-readable code (`E_IO`, `E_BUSY`, `E_NOT_FOUND`,
`E_ALLOWLIST`, `E_DEDUP`), a human-readable message, a `retryable` boolean, a `retryAfterMs`
duration when applicable, and optional code-specific details. The storage-error taxonomy
established in `runtime-productionization/CONTRACTS.md §B` is the pattern to follow.

**Generalized example:** CLI tools, MCP servers, and API consumers all need to distinguish
"retry this" from "don't retry this" from "this is a bug." Structured errors with codes enable
programmatic handling without parsing error messages. This is infrastructure-level.

### 7.2 Content-Addressed Cache with TTL

A durable cache where entries are keyed by content hash and automatically expire after a
configurable TTL. Written to SQLite for durability across restarts. Optionally backed by an
in-memory LRU layer for hot reads.

**Generalized example:** Live query results from GitHub search, fetched file manifests, and
downloaded ONNX models all benefit from caching with TTL. Reusing a cached response within its
TTL avoids unnecessary network calls and rate limits. A content-addressed cache tied to
content-hash invalidation ensures cache coherence.

### 7.3 Event Bus / Notification Pattern

When a long-running task completes (catalog update finishes, embedding refresh completes), the
system should be able to notify interested consumers. This could be a simple callback registry,
an EventEmitter, or a polling mechanism over the task queue.

**Generalized example:** After a background catalog update completes, the HTTP server needs to
know so it can serve fresh results. After an embedding refresh completes, the search index
needs to know. A push-based notification (rather than polling) reduces latency and complexity.
This is a thin pattern — a callback registration + invocation, not a message broker.

---

## 8. References

- `BACKLOG.md` — Root backlog with BL-114 through BL-169
- `libs/data/**/BACKLOG.md` — Per-package backlogs
- `docs/plan/runtime-productionization/06-hardening-final/SHARDS.md` — S11 (ingest consolidation)
- `docs/plan/runtime-productionization/06-hardening-final/RESUME.md` — Open BL items catalog
- `docs/plan/blob-store/SPEC.md` — Existing SPEC
- `docs/plan/claim-verification/SPEC.md` — Existing SPEC
- `docs/plan/retrieval-infrastructure/SPEC.md` — Existing SPEC (embed, vector, ingest, hybrid)
- `docs/plan/task-queue/SPEC.md` — New SPEC (companion)
- `docs/plan/source-provider/SPEC.md` — New SPEC (companion)
