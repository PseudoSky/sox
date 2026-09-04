# @adhd/sox-blob-store

Content-addressable blob storage for Node: `put()` raw bytes, get back a SHA-256 hash; `get(hash)`
gives you the bytes back. Identical content is written once (idempotent dedup), writes are crash-safe
(temp file → atomic rename, DB record before file), and unreferenced blobs are reclaimed by a
mark-and-sweep garbage collector with a grace period, an in-process FD guard that never deletes a
blob someone is actively reading, and a cross-process lock so two processes running GC against the
same store directory never sweep at the same time. It keeps large content (documents, attachments,
media) out of your primary rows; you store the hash, blob-store owns the bytes.

Reference tracking (which hash is used by which caller) is a small table set — `refs`, `blob_meta`,
`gc_runs` — persisted through [`@adhd/sox-store-adapter`](https://www.npmjs.com/package/@adhd/sox-store-adapter).
By default that table set lives in an embedded SQLite file next to your blobs (single-writer, zero
setup). Hand `createBlobStore` a Turso-backed adapter instead (`adapter: await createTursoAdapter(...)`)
and reference tracking inherits store-adapter's `multiprocess-wal` mode — concurrent writers across
multiple OS processes, serialized through its `-tshm` coordinator — so many workers can `put()`/`addRef()`/`gc()`
against the same store file at once. The blob files themselves are already safe under concurrent
processes independent of the adapter: `put()` hashes content client-side and writes to a unique temp
path before an atomic `rename()`, so two processes racing to store the same bytes just redundantly
write the same immutable destination path.

```bash
pnpm add @adhd/sox-blob-store
```

## Quick start

```typescript
import { createBlobStore } from '@adhd/sox-blob-store';

const store = createBlobStore({ basePath: './data/blobs' });
await store.open();

const hash = await store.put(new TextEncoder().encode('hello world'));
console.log(hash); // 64-char SHA-256 hex digest

const bytes = await store.get(hash);
console.log(new TextDecoder().decode(bytes!)); // "hello world"

// Track which record refers to this blob — required before it survives GC.
await store.addRef(hash, 'post:42', { role: 'attachment' });

await store.close();
```

## API reference

### `createBlobStore(config)`

```typescript
interface StoreConfig {
  basePath: string;             // directory where blob files + refs.db live
  tempDir?: string;              // default: `${basePath}/.tmp`
  refDbPath?: string;            // default: `${basePath}/refs.db`
  maxBlobSize?: number;          // enforced by putStream(); default: 1 GiB
  adapter?: StoreAdapter;        // supply your own (e.g. a Turso adapter) instead of the SQLite default
  gc?: {
    gracePeriodMs?: number;      // how long an unreferenced blob survives before GC deletes it
    maxDeletePerCycle?: number;  // cap deletions per gc() call
    autoGcIntervalMs?: number;   // if set, gc() runs automatically on this interval
  };
  verifyOnRead?: boolean;         // re-hash on every get()/getStream(); default: true
  verifyOnWrite?: boolean;        // re-hash immediately after write, before committing; default: false
}

function createBlobStore(config: StoreConfig): BlobStore;
```

### `BlobStore`

```typescript
class BlobStore {
  readonly fdGuard: FdGuard;
  readonly isOpen: boolean;

  open(): Promise<void>;
  close(): Promise<void>;

  // Core CAS operations
  put(data: Uint8Array): Promise<string>;                              // returns the SHA-256 hash
  putStream(stream: ReadableStream<Uint8Array>): Promise<string>;
  get(hash: string): Promise<Uint8Array | null>;
  getStream(hash: string): Promise<ReadableStream<Uint8Array> | null>;
  has(hash: string): Promise<boolean>;
  exists(hash: string): Promise<boolean>;                               // alias of has()
  delete(hash: string): Promise<boolean>;

  // Size / listing
  count(): Promise<number>;
  totalSize(): Promise<number>;
  sizeOf(hash: string): Promise<number>;
  listBlobs(opts?: { prefix?: string; limit?: number; offset?: number }): AsyncIterable<string>;

  // Reference tracking
  addRef(blobHash: string, referrer: string, context?: Record<string, unknown>): Promise<void>;
  addRefs(blobHashes: string[], referrer: string, context?: Record<string, unknown>): Promise<void>;
  removeRef(blobHash: string, referrer: string): Promise<void>;
  removeAllRefs(referrer: string): Promise<void>;
  getRefsForReferrer(referrer: string): Promise<string[]>;
  getReferrersForBlob(blobHash: string): Promise<string[]>;
  refCount(blobHash: string): Promise<number>;

  // Garbage collection
  getOrphans(opts?: { t_before?: string; limit?: number }): Promise<Array<{ hash: string; size: number; lastRefRemoved: string | null }>>;
  gc(opts?: GCOpts): Promise<GcResult>;
  gcProgress(): AsyncIterable<{ phase: 'mark' | 'sweep'; processed: number; total: number; bytesScanned: number }>;
  getGcHistory(opts?: { limit?: number; offset?: number }): Promise<GcResult[]>;
  cancelGc(): Promise<boolean>;
  pin(hash: string): Promise<void>;
  unpin(hash: string): Promise<void>;
  isPinned(hash: string): Promise<boolean>;

  // Integrity
  verify(hash: string): Promise<VerificationResult>;
  verifyAll(opts?: { concurrency?: number; onCorrupt?: 'warn' | 'delete' | 'fail' }): AsyncIterable<VerificationResult>;
  checkConsistency(): Promise<ConsistencyReport>;
  repairDangling(): Promise<RepairResult>;

  // Bulk transfer + observability
  export(target: BlobStore, opts?: { filter?: (hash: string) => boolean }): Promise<ExportStats>;
  metrics(): Promise<BlobStoreMetrics>;
}

function sha256Hex(data: Uint8Array): string;   // hash content without a store instance
function isNotFound(err: unknown): boolean;     // portable check for "not found" errors
```

Also exported for advanced use: `applySchema(adapter)` / `SCHEMA_SQL` (the raw `refs`/`blob_meta`/`gc_runs`
DDL — `open()` already applies it for you, this is for migration tooling that needs it standalone),
`InProcessFdGuard` / the `FdGuard` interface (the default in-process read-guard `BlobStore` uses
internally, exposed for a custom implementation), and `GCOpts` / `GcBlobInfo` (the `gc()` option and
result-item shapes).

### Errors

All thrown errors extend `BlobStoreError`:

```typescript
class BlobStoreError extends Error {}
class BlobNotFound extends BlobStoreError {
  readonly hash: string;
}
class IntegrityMismatch extends BlobStoreError {
  readonly hash: string;
  readonly expectedHash: string;
  readonly computedHash: string;
  readonly size: number;
}
class GCInProgress extends BlobStoreError {
  readonly startedAt: string;
}
class BlobStoreSystemError extends BlobStoreError {
  readonly cause?: Error;
}
class BlobStoreNotOpenError extends BlobStoreError {}
```

## Streaming large blobs

`put`/`get` take `Uint8Array` in memory; `putStream`/`getStream` avoid buffering the whole blob:

```typescript
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

const webStream = Readable.toWeb(createReadStream('./video.mp4')) as ReadableStream<Uint8Array>;
const hash = await store.putStream(webStream);

const readBack = await store.getStream(hash);
const reader = readBack!.getReader();
// pump reader.read() until { done: true }
```

`putStream` enforces `maxBlobSize` (default 1 GiB) while streaming and aborts before the temp file
is ever renamed into place if the cap is exceeded.

## Reference-counted garbage collection

A blob is eligible for GC once its ref count reaches zero — `gc()` is mark-and-sweep with a grace
period so a blob that just lost its last ref isn't deleted out from under a concurrent write:

```typescript
const store = createBlobStore({
  basePath: './data/blobs',
  gc: { gracePeriodMs: 60_000, maxDeletePerCycle: 500 },
});
await store.open();

// Dry run first — see what WOULD be deleted without deleting anything.
const preview = await store.gc({ dryRun: true });
console.log(`${preview.orphans.length} orphaned blobs, ${preview.totalOrphanBytes} bytes`);

// Real run.
const result = await store.gc();
console.log(`freed ${result.bytesFreed} bytes across ${result.deleted} blobs`);
```

GC takes an exclusive cross-process file lock (`.lock.acquire` in `basePath`, `flock`-style
create-exclusive + poll) before it runs, so only one process sweeps at a time regardless of how
many processes have the store open. Pin a blob to exempt it from GC entirely:

```typescript
await store.pin(hash);        // survives GC even with zero refs
await store.unpin(hash);
```

Subscribe to progress on a long GC run:

```typescript
for await (const progress of store.gcProgress()) {
  console.log(`${progress.phase}: ${progress.processed}/${progress.total}`);
}
```

## Integrity verification

```typescript
// Re-hash a single blob against its content-address.
const result = await store.verify(hash);
if (!result.match) {
  console.error(`corruption: expected ${result.hash}, got ${result.computedHash}`);
}

// Re-hash every blob in the store.
for await (const r of store.verifyAll({ onCorrupt: 'warn' })) {
  if (!r.match) console.warn(`corrupt blob: ${r.hash}`);
}
```

`verifyOnRead` defaults to `true`: every `get()`/`getStream()` re-hashes the bytes against the
requested hash before returning them, throwing `IntegrityMismatch` on a mismatch instead of handing
back corrupt data. Set it to `false` to skip that check on the read path when you've already verified
elsewhere and want to avoid the extra hashing cost. `verifyOnWrite` (default `false`) re-hashes
immediately after every `put()`, before the write is committed.

### Consistency checking and crash recovery

Every mutation is ordered so a crash mid-write leaves only the safe residue — a DB record with no
file yet (`put`) never happens before the file exists at its final path in the recoverable direction;
`delete`/GC remove the DB record before the file, so a crash there leaves an orphan file rather than
a dangling reference that reads would fail against. `checkConsistency()` finds both kinds of residue;
`repairDangling()` safely reclaims dangling records that have zero live refs (crash residue) while
leaving alone any dangling record that still has a ref — that shape means real data loss, and is
reported for you to investigate rather than silently deleted:

```typescript
const report = await store.checkConsistency();
console.log(`${report.orphanCount} orphan files, ${report.danglingCount} dangling records`);

const repair = await store.repairDangling();
console.log(`reclaimed ${repair.reclaimed} dangling records`);
if (repair.unreclaimed.length > 0) {
  console.error('records with live refs but no file — real data loss:', repair.unreclaimed);
}
```

Orphaned temp files (an interrupted write) are cleaned up automatically the next time `open()` runs.

## Exporting between stores

```typescript
const source = createBlobStore({ basePath: './data/blobs-old' });
const target = createBlobStore({ basePath: './data/blobs-new' });
await source.open();
await target.open();

const stats = await source.export(target, { filter: (hash) => hash.startsWith('a') });
console.log(`copied ${stats.blobsCopied} blobs, ${stats.bytesCopied} bytes, skipped ${stats.blobsSkipped}`);
```

## Invariants

- `put()`/`putStream()` are always idempotent — content-hash dedup is universal; storing the same
  bytes twice returns the same hash and does not write twice.
- `rename()` is atomic only when `tempDir` and `basePath` are on the same filesystem — keep the
  default (`tempDir` inside `basePath`) unless you know your deployment target crosses a mount boundary.
- GC never deletes a blob that has an open read/write handle in the in-process `FdGuard`, and never
  runs two sweeps concurrently across processes — the cross-process lock serializes them.
- `get()`/`getStream()` return `null` for a hash that was never written or has been GC'd; corruption
  on a hash that IS present throws `IntegrityMismatch`, never a silent `null`.
- `addRef()` requires the blob to already exist (`has(hash) === true`) — you cannot reference a hash
  that hasn't been `put()` yet.
