# SPEC — `@adhd/sox-blob-store`

> Content-addressable blob storage: two-phase CAS write (SHA-256 temp → atomic rename),
> SQLite reference tracking, stream-based API, and garbage collection.
> Q&A-iterated design, 2026-06-29. All outstanding questions resolved (see §Decisions log).

---

## Table of Contents

1. [Use cases & design drivers](#1-use-cases--design-drivers)
2. [`StoreConfig` — store-level options](#2-storeconfig--store-level-options)
3. [`BlobStore` — primary interface](#3-blobstore--primary-interface)
4. [Two-phase write semantics](#4-two-phase-write-semantics)
5. [SQLite schema](#5-sqlite-schema)
6. [Reference tracking](#6-reference-tracking)
7. [GC API](#7-gc-api)
8. [Open FD guard](#8-open-fd-guard)
9. [Integrity verification](#9-integrity-verification)
10. [Error taxonomy](#10-error-taxonomy)
11. [Decisions log](#11-decisions-log)
12. [Spec gaps](#12-spec-gaps)

---

## 1. Use cases & design drivers

Three generalized use cases drive the interface:

| Use case | Dedup driver | Write concurrency | GC strategy | Integrity concern |
|---|---|---|---|---|
| **CI artifact cache** | Parallel matrix jobs produce identical outputs | Many concurrent writers to same hash | Remove after last ref dropped; no grace period | Low — artifacts are reproducible |
| **Media asset manager** | Same photo → 10 posts | Sequential uploads, no collision risk | Grace period before delete; integrity reads | High — user media is irreplaceable |
| **Package registry mirror** | Same tarball → multiple versions | Bulk import with overlapping content | Grace period; dry-run before sweep | High — serve must never return corrupt data |

**Cross-cutting requirements:**
- Content-hash dedup is universal — `put` is always idempotent
- Atomic writes must serve zero partial content regardless of crash timing
- Stream-based API for blobs that exceed available memory
- GC must never delete a blob that is currently open for read
- Integrity is verified on every read — silent corruption is detected, not served

---

## 2. `StoreConfig` — store-level options

```ts
interface StoreConfig {
  // Root directory for stored blobs. Created on first open if it does not exist.
  // Blobs are stored at: <basePath>/<first 2 hex chars of hash>/<remaining hex hash>
  // e.g. basePath = "/data/blobs", hash = "a1b2c3..." → "/data/blobs/a1/a1b2c3..."
  // Fan-out avoids directory size explosion on filesystems with per-directory limits.
  basePath: string

  // Temporary directory for in-flight writes. Defaults to <basePath>/.tmp
  // if not specified. Must be on the same filesystem as basePath for atomic rename.
  tempDir?: string

  // Path to the SQLite database for reference tracking.
  // Defaults to <basePath>/refs.db.
  refDbPath?: string

  // Maximum blob size in bytes. put() and get() check this before allocating
  // memory. putStream() checks during streaming and fails fast if the blob
  // exceeds this limit. Default: 1_073_741_824 (1 GB).
  maxBlobSize?: number

  // ── GC settings ──────────────────────────────────────────────────────────
  gc?: {
    // Minimum age (in milliseconds) of an unreferenced blob before GC
    // may delete it. Default: 0 (immediate deletion once unreferenced).
    // Use for media asset manager or package registry to provide a
    // safety window before deletion.
    gracePeriodMs?: number

    // Maximum blobs to delete in a single GC cycle. Default: 1000.
    // Prevents long-running GC from blocking other operations.
    maxDeletePerCycle?: number

    // Interval in milliseconds between automatic GC sweeps.
    // 0 or undefined disables automatic GC.
    autoGcIntervalMs?: number
  }

  // ── Integrity / safety ───────────────────────────────────────────────────
  // Verify SHA-256 on every read (compute hash, compare to key).
  // Default: true. Disabling is a performance escape hatch for trusted
  // storage only — callers that disable it accept silent corruption risk.
  verifyOnRead?: boolean

  // Verify SHA-256 after rename on every write (read blob back, compute hash,
  // compare to expected). Catches filesystem-level bit rot at write time
  // rather than only on read. Default: false (read-time verification is
  // sufficient for most deployments; enable for high-durability requirements).
  verifyOnWrite?: boolean
}
```

**Directory layout (example with `basePath = /data/blobs`):**

```
/data/blobs/
├── .tmp/                           # temp directory for in-flight writes
├── refs.db                         # SQLite database (default location)
├── a1/
│   ├── a1b2c3d4e5f6...aabbcc       # blob file named by its full SHA-256 hex
│   └── fedcba987654...001122
├── ff/
│   └── ff0011223344...deadbeef
└── ...
```

**Fan-out directory creation**: The blob store creates the two-level prefix directory
on first write. This keeps directory entries per directory bounded at 256² = 65,536
entries even for very large stores (millions of blobs).

---

## 3. `BlobStore` — primary interface

```ts
// ── Write ──────────────────────────────────────────────────────────────────

// Writes a blob from an in-memory buffer. Returns the content hash.
// Idempotent — if the hash already exists, returns immediately without I/O.
// THROWS BlobStoreSystemError on storage failure.
put(data: Uint8Array): Promise<string>

// Writes a blob from a Readable stream. Returns the content hash.
// Preferred for large blobs (>100KB). Stream is consumed fully or rejected.
// If the stream errors mid-write, the temp file is cleaned up automatically.
putStream(stream: ReadableStream<Uint8Array>): Promise<string>

// ── Read ──────────────────────────────────────────────────────────────────

// Reads a blob entirely into memory. Returns null if the hash does not exist.
// THROWS IntegrityMismatch if verifyOnRead is true and hash does not match content.
// THROWS BlobStoreSystemError on storage failure.
get(hash: string): Promise<Uint8Array | null>

// Reads a blob as a ReadableStream for streaming consumption.
// Returns null if the hash does not exist.
// THROWS IntegrityMismatch on first read chunk if hash does not match content.
getStream(hash: string): Promise<ReadableStream<Uint8Array> | null>

// ── Existence ─────────────────────────────────────────────────────────────

// Quick existence check without reading content. Uses the filesystem stat()
// or the ref DB — whichever is faster. Does NOT verify integrity.
has(hash: string): Promise<boolean>

// Alias for has(). Retained for readability in conditional contexts.
exists(hash: string): Promise<boolean>

// ── Deletion ──────────────────────────────────────────────────────────────

// Deletes a blob from disk unconditionally. Does NOT check references —
// this is a low-level operation. Most callers should use GC instead.
// Returns true if the blob existed and was deleted, false if it did not exist.
// THROWS BlobStoreSystemError on storage failure.
// THROWS GCInProgress if GC is currently sweeping (caller must retry).
delete(hash: string): Promise<boolean>

// ── Maintenance ───────────────────────────────────────────────────────────

// Returns the total number of blobs on disk (actual files, not refs).
count(): Promise<number>

// Returns the total on-disk size in bytes of all blobs.
totalSize(): Promise<number>

// Returns the on-disk size in bytes of a single blob. 0 if not found.
sizeOf(hash: string): Promise<number>

// Returns a list of all blob hashes. Optional prefix filter.
// WARNING: on large stores this may return millions of entries. Use with limit/offset.
listBlobs(opts?: { prefix?: string; limit?: number; offset?: number }): AsyncIterable<string>

// ── Lifecycle ──────────────────────────────────────────────────────────────

// Opens the store: creates directories, opens SQLite DB, applies schema.
// Must be called before any other method. Idempotent.
open(): Promise<void>

// Closes the store: closes SQLite DB, flushes pending writes.
// Further method calls (except open) will reject.
close(): Promise<void>

// Returns true if open() has been called and close() has not.
readonly isOpen: boolean
```

**Method naming rationale:**
- `put`/`get` — standard key-value convention; the key is the content hash
- `has` — clearer than `exists` for a quick check; `exists` retained as alias
- `putStream`/`getStream` — explicit stream variant naming (not `writeBlob` etc.)
- `delete` — low-level; GC is the public sweep interface

```ts
// ── Export ────────────────────────────────────────────────────────────────────

// Bulk-copy blobs matching the optional filter to another BlobStore.
// Blobs are read, verified, and written; the target store must be on the same
// or a compatible filesystem. Returns stats about the transfer.
export(target: BlobStore, opts?: {
  filter?: (hash: string) => boolean
}): Promise<ExportStats>

interface ExportStats {
  blobsCopied: number
  bytesCopied: number
  blobsSkipped: number
  durationMs: number
}

// ── Metrics ───────────────────────────────────────────────────────────────────

// Return live metrics for the store instance. Counts are approximate
// (updated periodically, not on every mutation).
metrics(): BlobStoreMetrics

interface BlobStoreMetrics {
  totalBlobs: number
  totalBytes: number
  orphanCount: number
  gcRuns: number
  gcBytesFreed: number
  readCount: number
  writeCount: number
  dedupSavings: number
}
```

---

## 4. Two-phase write semantics

```ts
interface TwoPhaseWriteResult {
  hash: string            // SHA-256 of the content
  deduplicated: boolean   // true if the blob already existed (no new file written)
  tempPath?: string       // path of the temp file (cleaned up after rename)
  finalPath: string       // final path of the blob
}
```

### Phase 1 — Temp file

1. A temp file is created in `tempDir` (default: `<basePath>/.tmp`)
2. Content is written (directly or via stream pipe)
3. SHA-256 is computed incrementally during the write
4. On success: proceed to Phase 2
5. On error (write failure, stream error): the temp file is deleted immediately

### Phase 2 — Atomic rename

**POSIX (macOS, Linux):**
```
rename(tempPath, finalPath)
```
POSIX guarantees `rename()` is atomic when source and destination are on the same
filesystem. The file either exists at the new path or it does not — no partial state.
The `tempDir` MUST be on the same filesystem as `basePath`; the StoreConfig contract
enforces this by default (`tempDir` defaults to `<basePath>/.tmp`).

**Windows:**
```
MoveFileExW(tempPath, finalPath, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
```
`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` is atomic on the same NTFS volume.
If `tempDir` and `basePath` are on different volumes, the store falls back to
copy + delete (non-atomic but transactional cleanup via SQLite marker).

### Crash recovery

If the process crashes between Phase 1 and Phase 2:
- The temp file remains in `tempDir` — orphaned.
- On next `open()`, the store scans `tempDir` for orphaned `.tmp` files and deletes them.
- No partial blob is ever visible at the final path because the rename never occurred.

### Dedup fast-path

Before writing, the store checks if the hash already exists on disk (via `has()`).
If it does, the temp file is deleted (if created), and the write returns immediately
with `deduplicated: true`. No I/O beyond the existence check.

This means `put` is safe to call concurrently with the same content from N writers:
only the first writer's rename lands; the other N-1 writers compute the hash, see
the file exists, and return.

### Concurrent collision handling

When two writers produce the same content simultaneously, both may pass the dedup
fast-path before either renames. To handle this race:

1. Temp files are created with `O_EXCL` (or equivalent platform flag). If two
   writers pick the same temp path, the second writer receives `EEXIST` / `EEXISTS`.
2. On `EEXIST`, the second writer does not retry the temp file — it polls for the
   final path (up to a 5-second timeout). If the final path appears, it returns
   `deduplicated: true`.
3. If the final path does not appear within the timeout (indicating the first
   writer crashed), the second writer creates a new temp file with a randomized
   suffix and retries Phase 1.

### Cross-process GC lock

Two `BlobStore` instances operating on the same `basePath` must not run GC
simultaneously. Before any GC cycle, the store acquires an advisory file lock:

```
flock(fd, LOCK_EX)   // on <basePath>/.lock
```

- **GC only** — reads, writes, and reference operations do not acquire the lock.
  The lock serializes only GC sweeps, not normal I/O.
- **Blocking** — if another process holds the lock, `gc()` blocks until the lock
  is released or a configurable timeout elapses (default: 30 s). On timeout,
  `gc()` throws `GCInProgress`.
- **Release on crash** — the OS automatically releases the `flock` when the
  holding process terminates, so a crashed GC cannot permanently block
  subsequent runs.
- **Lock file** — `<basePath>/.lock` is created on first acquisition and
  left in place thereafter (flock is file-descriptor-based; the file imposes
  no cost when unused).

---

## 5. SQLite schema

```sql
-- Refs database: tracks which "referrers" reference which blobs.
-- One ref DB per store instance. Created at <refDbPath> on first open().

-- The refs table is a many-to-many relationship:
--   one blob ←→ many referrers
--   one referrer → many blobs
-- A referrer is identified by a string key (e.g. "post:42", "build:ci-123", "pkg:lodash@4.17.21").
-- This avoids coupling the blob store to any application-level entity model.

CREATE TABLE IF NOT EXISTS refs (
  -- The SHA-256 hex hash of the referenced blob (64 hex chars)
  blob_hash    TEXT    NOT NULL,
  -- Application-level referrer identifier
  referrer     TEXT    NOT NULL,
  -- When this reference was first created
  t_created    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- When this reference was last verified / touched
  t_touched    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Optional context: why this referrer references this blob.
  -- Stored as JSON. Example: '{"role":"avatar","width":800,"format":"webp"}'
  context      TEXT,

  PRIMARY KEY (blob_hash, referrer),
  FOREIGN KEY (blob_hash) REFERENCES blob_meta(hash) ON DELETE CASCADE
) STRICT;

-- Metadata about each blob (computed at write time, immutable after).
CREATE TABLE IF NOT EXISTS blob_meta (
  hash         TEXT    PRIMARY KEY,   -- SHA-256 hex
  size         INTEGER NOT NULL,      -- bytes
  t_created    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  mime_type    TEXT                   -- optional; detected at write time
) STRICT;

CREATE INDEX IF NOT EXISTS idx_refs_referrer ON refs(referrer);
CREATE INDEX IF NOT EXISTS idx_refs_t_created ON refs(t_created);
CREATE INDEX IF NOT EXISTS idx_blob_meta_t_created ON blob_meta(t_created);

-- GC tracking: table-driven instead of flag-based to record GC history.
CREATE TABLE IF NOT EXISTS gc_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  t_started      TEXT    NOT NULL,
  t_ended        TEXT,
  dry_run        INTEGER NOT NULL DEFAULT 0,  -- boolean
  blobs_marked   INTEGER NOT NULL DEFAULT 0,  -- candidates identified
  blobs_deleted  INTEGER NOT NULL DEFAULT 0,  -- actually removed
  bytes_freed    INTEGER NOT NULL DEFAULT 0,
  error          TEXT                          -- null on success, message on failure
) STRICT;

CREATE INDEX IF NOT EXISTS idx_gc_runs_t_started ON gc_runs(t_started);
```

**Why a separate `refs` table instead of a simple counter:**
- Counter per blob only tells you "≥1 ref exists" — it doesn't say who holds it.
- A referrer-aware table lets GC target blobs whose *specific* referrer(s) are gone.
- The `context` JSON field enables future provenance queries ("which post uses this image as a thumbnail?").

**Why `STRICT` tables:**
- SQLite's `STRICT` keyword enforces column type affinity at the database level.
- Catches type mismatches (e.g. inserting a string into an INTEGER column) before
  they silently coerce. Matches `@adhd/sox-graph-store` convention.

---

## 6. Reference tracking

```ts
// ── Reference management methods on BlobStore ──────────────────────────────

// Record that `referrer` references `blobHash`. Idempotent.
// If the referrer+blob pair already exists, updates t_touched.
// THROWS BlobNotFound if blobHash does not exist on disk.
addRef(blobHash: string, referrer: string, context?: Record<string, unknown>): Promise<void>

// Record that `referrer` references multiple blobs. Atomic (single SQLite transaction).
// Idempotent per pair. THROWS BlobNotFound for any hash that does not exist.
addRefs(blobHash: string[], referrer: string, context?: Record<string, unknown>): Promise<void>

// Remove a single reference. Does NOT delete the blob.
// Idempotent — removing a non-existent ref is a no-op.
removeRef(blobHash: string, referrer: string): Promise<void>

// Remove all references held by a referrer. Atomic.
// Does NOT delete blobs. Idempotent.
removeAllRefs(referrer: string): Promise<void>

// Return all blobs referenced by a referrer.
getRefsForReferrer(referrer: string): Promise<string[]>

// Return all referrers that reference a given blob.
getReferrersForBlob(blobHash: string): Promise<string[]>

// Return the count of referrers for a given blob.
refCount(blobHash: string): Promise<number>

// Return all blobs that have zero referrers (GC candidates).
// Optional t_before: only return blobs whose last ref was removed before this timestamp.
// This is used to implement the grace period: a blob whose last ref was removed
// < gracePeriod ago is not a candidate.
getOrphans(opts?: {
  t_before?: string       // ISO timestamp; default: now - gracePeriodMs
  limit?: number
}): Promise<Array<{ hash: string; size: number; lastRefRemoved: string | null }>>
```

**Reference lifecycle contract:**

```
addRef(hash, referrer)
    │
    ▼
blob has ≥1 ref → NOT an orphan → GC skips it
    │
removeRef(hash, referrer)    (last ref removed)
    │
    ▼
blob has 0 refs → orphan
    │
    ▼
wait gracePeriodMs
    │
    ▼
getOrphans() returns it → GC sweep deletes it
```

The grace period exists only in the GC query (`getOrphans` filters by `t_before`).
The `refs` table does not have a "pending deletion" state. This avoids state
machinery in the reference tracking layer — the application layer (GC) enforces
the grace window via timestamp comparison.

---

## 7. GC API

```ts
// ── GC types ───────────────────────────────────────────────────────────────

interface GCOpts {
  // When true, identify orphaned blobs but do NOT delete them.
  // Report results through GcProgress stream and GcResult. Default: false.
  dryRun?: boolean

  // Override the configured grace period for this GC run. Default: config.gracePeriodMs.
  gracePeriodMs?: number

  // Maximum blobs to delete in this run. Default: config.maxDeletePerCycle.
  maxDelete?: number
}

interface GcBlobInfo {
  hash: string
  size: number
  lastRefRemoved: string | null   // ISO timestamp; null if never referenced
  tCreated: string                // ISO timestamp
}

interface GcResult {
  dryRun: boolean
  tStarted: string
  tEnded: string
  durationMs: number

  // Phase 1: mark — identify orphans
  orphans: GcBlobInfo[]
  totalOrphanBytes: number

  // Phase 2: sweep — delete eligible orphans
  deleted: number                 // count of blobs actually deleted
  bytesFreed: number

  // Errors encountered during sweep (individual blob deletions may fail
  // if the FD guard prevents it; these are logged, not fatal).
  errors: Array<{ hash: string; error: string }>
}

// ── GC methods on BlobStore ──────────────────────────────────────────────

// Run a single GC cycle: mark phase (identify orphans), then sweep phase
// (delete eligible orphans). Returns GcResult.
// THROWS GCInProgress if a concurrent GC is already running.
gc(opts?: GCOpts): Promise<GcResult>

// Stream progress events during a GC run. Useful for CLI progress bars
// or real-time monitoring. The AsyncIterable yields one event per batch
// of blobs processed during the mark and sweep phases.
gcProgress(): AsyncIterable<{
  phase: 'mark' | 'sweep'
  processed: number
  total: number
  bytesScanned: number
}>

// Return GC history from the gc_runs table.
getGcHistory(opts?: { limit?: number; offset?: number }): Promise<GcResult[]>

// Cancel an in-progress GC run. Best-effort — GC will stop at the next
// batch boundary. Returns true if a GC was running and was cancelled.
cancelGc(): Promise<boolean>
```

### GC algorithm (mark-and-sweep)

```
Phase 1: Mark
  ── Query getOrphans(t_before = now - gracePeriodMs)
  ── For each orphan, check if any FD guard holds the hash open.
  ── If FD guard holds: skip (orphan but not deletable yet).
  ── If FD guard does not hold: add to mark list.
  ── Yield progress events every 1000 blobs.

Phase 2: Sweep
  ── For each marked blob:
      1. Verify it is still an orphan (double-check refs table within the
         same SQLite transaction. A ref may have been added between mark and sweep.)
      2. Verify no FD guard holds it (re-check the guard).
      3. Delete the file from disk.
      4. Remove the blob_meta row (CASCADE deletes refs).
      5. Yield progress event.
  ── Record a gc_runs row with results.
  ── If cancelGc() was called: stop at the next batch boundary; record partial results.
```

**Why double-check at sweep time:** Between mark and sweep, another process/thread
could `addRef()` to an orphan. The database-level re-check prevents deleting a blob
that just acquired its first reference. This is a short window, but the cost is one
SQLite query per deleted blob — negligible compared to the file deletion I/O.

---

## 8. Open FD guard

```ts
// Guards against concurrent GC deletion of a blob that is currently being read.
// One guard per BlobStore instance. Readers register interest; GC queries the guard.
// The guard is an in-process concern only — it does not synchronize across processes.

interface FdGuard {
  // Register interest in a hash. Returns a release function.
  // Pairs must be balanced: every acquire must result in exactly one release.
  // THROWS BlobNotFound if the hash does not exist on disk.
  acquire(hash: string): Promise<() => void>

  // Returns true if at least one FD is currently held for this hash.
  isHeld(hash: string): boolean

  // Returns all hashes that currently have open FDs (for diagnostic / monitoring).
  activeHashes(): string[]
}

// The guard is exposed on the BlobStore instance:
const store: BlobStore
store.fdGuard: FdGuard
```

**Integration with get/getStream:**

```ts
// Internal pseudocode — not part of the public interface:

async function getStream(hash: string): Promise<ReadableStream | null> {
  if (!await has(hash)) return null

  const release = await fdGuard.acquire(hash)
  const fileStream = createReadStream(resolvePath(hash))

  // Wrap the stream to release on close/error
  const guarded = fileStream.pipeThrough(new TransformStream({
    cancel() { release() },
    // ...forward chunks
  }))

  // Ensure release even if the caller never reads or cancels
  guarded.closed.then(release, release)

  return guarded
}
```

**Why an explicit guard instead of relying on OS file locks:**
- OS file locks (`flock`, `LockFileEx`) have platform-specific semantics and
  do not compose well with `rename()` or `unlink()` — on Linux, `unlink()` succeeds
  even while another process holds the fd for read; the inode persists until the fd
  closes, but the directory entry is gone, confusing application-level state.
- A userland guard gives explicit, cross-platform semantics: "GC will not delete
  a blob whose hash is registered in the guard." No OS-level lock contention.
- The guard is per-process. Cross-process safety is an orthogonal concern (use
  filesystem-level coordination or a shared SQLite-based lock table if needed).

---

## 9. Integrity verification

```ts
// Verification is built into get/getStream when config.verifyOnRead === true.
// It can also be called explicitly for offline integrity checks.

interface VerificationResult {
  hash: string
  size: number
  computedHash: string
  match: boolean
  tVerified: string   // ISO timestamp
}

interface BlobStore {
  // Verify a single blob. Reads the full file content, computes SHA-256,
  // compares to the expected hash. Returns the verification result.
  // Does NOT throw on mismatch — returns VerificationResult with match: false.
  verify(hash: string): Promise<VerificationResult>

  // Verify all blobs on disk. AsyncIterable yields results as each blob is verified.
  // WARNING: on large stores this may take significant time and I/O bandwidth.
  verifyAll(opts?: {
    concurrency?: number    // default: 4
    onCorrupt?: 'warn' | 'delete' | 'fail'  // default: 'warn'
  }): AsyncIterable<VerificationResult>
}
```

**Integrity contract:**
- On `get(hash)`: if `verifyOnRead` is true (default), the full content is hashed
  before the Promise resolves. If the hash does not match, the blob is treated as
  corrupt — the data is discarded (not returned), and `IntegrityMismatch` is thrown.
- On `getStream(hash)`: the first chunk returned from the stream has already been
  verified. The hash is computed incrementally; the stream errors with
  `IntegrityMismatch` if a mismatch is detected. This means the caller receives
  verified content only — a partial valid prefix cannot be served.
- `verifyOnRead: false` skips the hash computation on reads but still returns the
  content as-is. This is a performance escape hatch; it should be a conscious choice.
- When `verifyOnWrite: true`, the store reads back the blob after rename, computes
  its SHA-256, and confirms it matches the expected hash. This detects
  filesystem-level bit rot or hardware faults at write time. If the verification
  fails, the blob file is deleted immediately and `BlobStoreSystemError` is thrown —
  the caller must retry the write. Write-time verification doubles the I/O per write
  but provides the earliest possible signal of storage integrity failure.

---

## 10. Error taxonomy

```ts
// ── Base error ────────────────────────────────────────────────────────────
class BlobStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlobStoreError'
  }
}

// ── Concrete errors ────────────────────────────────────────────────────────

// Thrown when a requested blob does not exist in the store.
// Returned by get (returns null instead), but thrown by addRef, verify,
// and fdGuard.acquire when the hash is unknown.
class BlobNotFound extends BlobStoreError {
  constructor(public readonly hash: string) {
    super(`blob not found: ${hash}`)
    this.name = 'BlobNotFound'
  }
}

// Thrown when a blob's on-disk content does not match its expected SHA-256 hash.
// Indicates silent corruption (bit rot, partial write, filesystem bug).
// The corrupted file is NOT deleted automatically — it must be investigated
// offline. GC will classify it as "unreferencable" on the next sweep.
class IntegrityMismatch extends BlobStoreError {
  constructor(
    public readonly hash: string,
    public readonly expectedHash: string,
    public readonly computedHash: string,
    public readonly size: number
  ) {
    super(
      `integrity mismatch for ${hash}: computed ${computedHash}, expected ${expectedHash}`
    )
    this.name = 'IntegrityMismatch'
  }
}

// Thrown when a GC operation is requested but a GC run is already in progress.
// The caller should retry after the current GC completes (or cancel it).
class GCInProgress extends BlobStoreError {
  constructor(public readonly startedAt: string) {
    super(`GC already in progress (started at ${startedAt})`)
    this.name = 'GCInProgress'
  }
}

// Thrown on unrecoverable storage errors: disk full, permission denied,
// SQLite IO error, filesystem error.
class BlobStoreSystemError extends BlobStoreError {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message)
    this.name = 'BlobStoreSystemError'
  }
}

// Thrown when the store is used before open() or after close().
class BlobStoreNotOpenError extends BlobStoreError {
  constructor() {
    super('blob store is not open')
    this.name = 'BlobStoreNotOpenError'
  }
}
```

---

## 11. Decisions log

| # | Question | Decision | Rationale |
|---|---|---|---|
| D-1 | Reference tracking — counter vs referrer-aware table | **Referrer-aware table** (`refs` with `referrer` column) | Counter (ref count per blob) cannot answer "who references this blob?"; a referrer-aware table enables targeted GC (delete blobs whose referrer is gone), provenance queries, and `context` metadata per reference. See §5. |
| D-2 | GC grace period — stored in refs vs config-driven | **Config-driven** (gracePeriodMs in StoreConfig.gc, applied at query time by getOrphans) | Storing a "pending deletion" timestamp in refs would add state machinery; applying the grace window via config at query time keeps the schema stateless and the GC logic transparent. See §6. |
| D-3 | FD guard — in-process vs cross-process | **In-process only** | Cross-process FD synchronization requires OS file locks or a shared lock DB — each with platform-specific semantics and complexity that most callers don't need. The in-process guard prevents the common case: a GC sweep deleting a blob that the same process is currently streaming. Cross-process safety is a future concern. See §8. |
| D-4 | Dedup check — before write vs after hash | **Before write** (check has() before creating temp file) | Saving the temp file creation + SHA-256 hash for blobs that already exist avoids unnecessary I/O. The race (two concurrent writers both compute hash before either renames) is harmless — the second rename overwrites the first, and the content is identical by definition. See §4. |
| D-5 | Temp dir — configurable vs forced to basePath/.tmp | **Configurable**, defaults to basePath/.tmp | Some deployments may want temp on a different device (tmpfs for speed) — but they must accept the cross-device rename risk. The default puts temp on the same filesystem for atomic rename guarantees. See §2. |
| D-6 | Stream integrity — verify at end vs verify on first chunk | **Verify on first chunk** (error the stream on mismatch) | Verifying only at the end means the caller has already consumed corrupt data; rejecting the stream on first mismatch ensures the caller never sees unverified content. The SHA-256 is computed incrementally — the first chunk triggers the first hash update, not the verification. Full verification completes at stream end; on mismatch the stream errors at that point. Amended: the stream CAN deliver content before verification completes (it must — the content is the verification input). The error surfaces at the END of the stream, not the first chunk. The key guarantee is: the last byte delivered before the stream ends is verified. A caller that reads the entire stream without error has verified content. |
| D-7 | verifyOnRead default | **True** (verify every read by default) | The three use cases all benefit from integrity verification; disabling it is a performance escape hatch for trusted storage where the caller can accept silent corruption risk. See §9. |
| D-8 | get() return type — null vs throw | **Return null** for not-found; throw for corruption (IntegrityMismatch) | Not-found is a normal condition (the blob may simply not exist); corruption is an invariant violation that should not be silently handled. Callers that need to distinguish the two check for null first, then catch IntegrityMismatch. |
| D-9 | GC double-check — same transaction at sweep time | **Yes** — re-verify orphan status inside the delete transaction | Between mark and sweep, a ref could be added. Re-checking prevents deleting a blob that just became live. The cost is one SQLite query per deletion — negligible vs file I/O. See §7. |
| D-10 | Auto GC — built-in vs external scheduler | **Built-in** via autoGcIntervalMs config | A built-in timer simplifies the common case (periodic GC during idle time). Callers that need precise control (only GC during maintenance windows) set autoGcIntervalMs: 0 and call gc() explicitly. See §2. |

---

## 12. Spec gaps

> Identified during design review. Items separated into **spec-level gaps** (generic
> interface omissions) vs. **implementation details** (belong in the SQLite package,
> not the spec).

---

### What belongs in the spec

#### 1. Cross-process FD coordination

The current FD guard (§8) is in-process only. A deployment running multiple
processes sharing the same blob store directory (e.g. a horizontally scaled
web server with a shared NFS mount) needs cross-process coordination to prevent
GC in process A from deleting a blob being read by process B.

**Resolution:** Add an optional `StoreConfig.lockBackend: 'memory' | 'sqlite' | 'advisory'`
that selects the FD coordination strategy. Default: `'memory'` (current behavior).
`'sqlite'` stores active FD hashes in a shared SQLite table (same DB as refs) with
heartbeat timestamps. GC queries this table before sweeping. Cross-process safety
is then bounded by heartbeat staleness (default: 10s grace per FD).

#### 2. Content-type detection

`blob_meta.mime_type` is set at write time (see §5 schema) but no detection logic
is specified. Different implementors will use different heuristics (magic bytes,
file extension, caller-provided hint).

**Resolution:** Add `StoreConfig.mimeDetect?: 'magic' | 'extension' | 'none'`
(default: `'magic'`). At write time, the store reads the first 512 bytes and
uses a magic-byte library to detect MIME type. When detection is `'none'`,
`mime_type` is stored as `null`.

#### 3. Blob pinning

A user may want to pin a blob so it is never GC'd regardless of ref count.
Common use cases: "keep this default avatar even if no post references it."

**Resolution:** Add a `pinned` column to `blob_meta` (boolean, default false).
GC queries `WHERE pinned = 0` alongside the orphan check. Add methods:
- `pin(hash: string): Promise<void>`
- `unpin(hash: string): Promise<void>`
- `isPinned(hash: string): Promise<boolean>`

#### 4. Storage migration (hot, zero-downtime)

Migrating all blobs from one `basePath` to another without taking the store
offline. Use cases: disk full, filesystem migration, rebalancing across mounts.

**Resolution:** Add a `migrate(targetBasePath, opts?)` method that:
1. Lists all blob hashes in the source store.
2. For each blob, copies the file to the target, verifies SHA-256, and updates
   the `refs.db` (or creates a new one at the target).
3. Switches the store's `basePath` to the target via an atomic symlink swap:
   - Source store writes to `basePath_symlink → /old/path`
   - Create `basePath_symlink_new → /new/path`
   - Atomic `rename(basePath_symlink_new, basePath_symlink)` — existing readers
     finish on the old inode; new readers land on the new path.
4. If migration fails mid-way, the source remains intact; the store rolls back
   the symlink. No blob is deleted from source until the migration commits.

**Constraints:**
- Target must have enough free space for all blobs.
- Migration is incremental: the store continues to accept writes during the copy;
  blobs written during migration are migrated on the next pass (dirty-blob re-scan).
- After symlink swap, old storage is kept for a configurable `keepSourceHours` before
  deletion, allowing rollback if corruption is discovered at the target.

---

### What belongs in the implementation, not the spec

**Specific fan-out depth** (e.g. 2 hex chars vs 1 char). The spec provides
the pattern (`<prefix>/<hash>`); the depth is a performance tuning parameter
for the SQLite package implementor, not an interface decision.

**Temp file naming convention** — the spec says "a temp file is created" but
does not mandate a naming scheme (UUID, PID+timer, etc.). That is an
implementation detail.

**Stream buffer size** — chunk size for `ReadableStream` piping is a tuning
parameter, not an interface concern.

**SHA-256 vs BLAKE3** — the spec uses SHA-256 as the canonical hash algorithm.
Changing to BLAKE3 or another digest is an implementation change that does not
affect the interface (the hash is always an opaque hex string). The algorithm
is documented here for concreteness but is not a contract.

**SQLite journal mode** (WAL vs DELETE) — the implementation chooses the
appropriate journal mode. The spec only defines the schema.

---

## Observability contract

Same pattern as all `@adhd/*` packages — `console` logging with `[blob-store]` prefix.

| Level | When | Example |
|---|---|---|
| `error` | Unrecoverable: disk full, SQLite corruption, binding failure | `console.error('[blob-store] disk full at', resolvedPath, err)` |
| `warn` | Degraded-but-functional: integrity mismatch logged and skipped, GC cancelled mid-run, slow GC cycle | `console.warn('[blob-store] integrity mismatch for', hash, '(logged, not deleted)')` |
| `info` | Health/state change: store opened, GC run completed, blob count reported | `console.info('[blob-store] GC run complete: deleted 42 blobs, freed 10.2 MB')` |
| `debug` | Per-operation detail: put/get/has timing, GC batch progress | `console.debug('[blob-store] get(' + hash.slice(0, 8) + '...) 2.1ms, hit')` |

---

## Dependency graph

```
blob-store    (better-sqlite3 — SQLite ref tracking)
              (no streaming dep — uses native Web Streams API)
              (no hashing dep — uses crypto.subtle.digest / Node crypto)
```

The blob store has zero compile-time dependencies on other `@adhd/*` packages.
It is designed as a standalone utility — any caller that needs content-addressable
storage with dedup and GC can use it independently.

---

## Dispatch

| | |
|---|---|
| **Agent** | `flash` |
| **Spec section** | Full document — new leaf package |
| **Files** | `libs/data/store/blob-store/` (new) |
| **Depends on** | none |

**Prompt notes for the agent:**
- Follow the existing `SqliteVectorBackend` pattern for SQLite setup (WAL pragma, better-sqlite3 DI)
- The `BlobStore` interface is the primary export
- Node.js built-in `crypto` for SHA-256; Node.js `fs` for file operations
- Stream variant uses native `ReadableStream` — no streaming library dependency
- All errors extend `Error` with descriptive names — no external error library
- Observability: `console` logging with `[blob-store]` prefix per the contract above
- Live verification: follow `CONTRIBUTING.md` §2.x for data lib (new leaf package)
