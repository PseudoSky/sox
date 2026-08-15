// ── BlobStore — content-addressable blob storage ─────────────────────────────

import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { type StoreAdapter, createSqliteAdapter } from '@adhd/sox-store-adapter';

import {
  BlobNotFound,
  IntegrityMismatch,
  GCInProgress,
  BlobStoreSystemError,
  BlobStoreNotOpenError,
} from './errors.js';
import { type FdGuard, InProcessFdGuard } from './fd-guard.js';
import { applySchema } from './schema.js';
import { type GcBlobInfo, type GcResult, type GcResultRow, type GCOpts } from './gc.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface StoreConfig {
  basePath: string;
  tempDir?: string;
  refDbPath?: string;
  maxBlobSize?: number;
  adapter?: StoreAdapter;
  gc?: {
    gracePeriodMs?: number;
    maxDeletePerCycle?: number;
    autoGcIntervalMs?: number;
  };
  verifyOnRead?: boolean;
  verifyOnWrite?: boolean;
}

export interface ExportStats {
  blobsCopied: number;
  bytesCopied: number;
  blobsSkipped: number;
  durationMs: number;
}

export interface BlobStoreMetrics {
  totalBlobs: number;
  totalBytes: number;
  orphanCount: number;
  gcRuns: number;
  gcBytesFreed: number;
  readCount: number;
  writeCount: number;
  dedupSavings: number;
}

export interface VerificationResult {
  hash: string;
  size: number;
  computedHash: string;
  match: boolean;
  tVerified: string;
}

/**
 * Result of checkConsistency() — a directory scan cross-referenced against
 * blob_meta, reporting both failure residues a write-order inversion can
 * leave behind. See BUG-EPIC-BLOBSTORE-WRITE-ORDER-INVERSION-001.
 */
export interface ConsistencyReport {
  scannedAt: string;
  orphanCount: number;
  danglingCount: number;
  /** File on disk, no blob_meta row. Safe — reclaimable disk space. */
  orphans: Array<{ hash: string; size: number }>;
  /** blob_meta row, no file on disk. Dangerous — reads against it fail. */
  dangling: Array<{ hash: string; size: number }>;
}

/** Result of repairDangling(). */
export interface RepairResult {
  /** Dangling rows with zero refs, safely deleted. */
  reclaimed: number;
  /** Dangling rows WITH live refs — real data loss, left for an operator. */
  unreclaimed: Array<{ hash: string; refCount: number }>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BLOB_SIZE = 1_073_741_824;
const DEFAULT_GC_MAX_DELETE = 1000;

// ── BlobStore ─────────────────────────────────────────────────────────────────

export class BlobStore {
  readonly fdGuard: FdGuard = new InProcessFdGuard(
    async (hash: string) => this.has(hash),
  );

  private config!: StoreConfig;
  private resolvedTempDir!: string;
  private adapter: StoreAdapter | null = null;
  private _isOpen = false;
  private gcInProgress = false;
  private gcStartedAt: string | null = null;
  private gcCancelled = false;
  private autoGcTimer: ReturnType<typeof setInterval> | null = null;

  // Metrics counters
  private readCount = 0;
  private writeCount = 0;
  private dedupSavings = 0;
  private gcRuns = 0;
  private gcBytesFreed = 0;

  // Internal event handlers for gcProgress subscribers
  private gcProgressListeners: Array<
    (evt: { phase: 'mark' | 'sweep'; processed: number; total: number; bytesScanned: number }) => void
  > = [];

  get isOpen(): boolean {
    return this._isOpen;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this._isOpen) return;
    const cfg = this.config;
    const basePath = cfg.basePath;
    const tempDir = cfg.tempDir ?? path.join(basePath, '.tmp');
    const dbPath = cfg.refDbPath ?? path.join(basePath, 'refs.db');

    this.resolvedTempDir = tempDir;

    await fsp.mkdir(basePath, { recursive: true });
    await fsp.mkdir(tempDir, { recursive: true });

    if (cfg.adapter) {
      this.adapter = cfg.adapter;
    } else {
      this.adapter = createSqliteAdapter({ dbPath });
    }
    await this.adapter.pragmaSet('journal_mode', 'WAL');
    await this.adapter.pragmaSet('busy_timeout', 5000);
    await this.adapter.pragmaSet('foreign_keys', 'ON');
    await applySchema(this.adapter);

    this._isOpen = true;
    console.info(`[blob-store] store opened: basePath=${basePath}`);

    await this.cleanupOrphanedTemp();

    const gcInterval = cfg.gc?.autoGcIntervalMs;
    if (gcInterval && gcInterval > 0) {
      this.autoGcTimer = setInterval(() => {
        this.gc().catch((err) => {
          console.error('[blob-store] auto-GC failed:', err);
        });
      }, gcInterval);
      if (typeof this.autoGcTimer.unref === 'function') {
        this.autoGcTimer.unref();
      }
    }
  }

  async close(): Promise<void> {
    if (!this._isOpen) return;
    if (this.autoGcTimer) {
      clearInterval(this.autoGcTimer);
      this.autoGcTimer = null;
    }
    if (this.adapter) {
      await this.adapter.close();
      this.adapter = null;
    }
    this._isOpen = false;
    console.info('[blob-store] store closed');
  }

  // ── Write ──────────────────────────────────────────────────────────────

  async put(data: Uint8Array): Promise<string> {
    this.ensureOpen();
    const hash = sha256Hex(data);
    this.writeCount++;

    if (await this.has(hash)) {
      this.dedupSavings++;
      return hash;
    }

    const tempPath = this.allocateTempPath();
    const fd = await fsp.open(tempPath, 'wx');
    await fd.writeFile(data);
    await fd.close();

    if (this.config.verifyOnWrite ?? false) {
      const result = await this.verifyPath(hash, tempPath);
      if (!result.match) {
        await fsp.unlink(tempPath).catch(() => {});
        throw new BlobStoreSystemError(
          `write-time integrity mismatch for ${hash}: expected ${hash}, computed ${result.computedHash}`,
        );
      }
    }

    // ── Write-order invariant (BUG-EPIC-BLOBSTORE-WRITE-ORDER-INVERSION-001) ──
    // The DB record is committed BEFORE the file is placed at its final path.
    // A crash between the two lines below leaves a dangling blob_meta row (no
    // file yet) — detectable via checkConsistency() and safely reclaimable via
    // repairDangling(), since nothing can have added a ref to it yet (addRef()
    // requires has(hash) === true, i.e. the file to already exist). The
    // opposite order — file first, DB record second — would instead risk an
    // undetectable orphan on crash (a file no DB-driven scan could ever find).
    await this.upsertMeta(hash, data.byteLength);

    const finalPath = this.blobPath(hash);

    try {
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      await fsp.rename(tempPath, finalPath);
    } catch (err) {
      await fsp.unlink(tempPath).catch(() => {});
      // Best-effort rollback of the dangling record we just created — collapses
      // the transient dangling window back to a fully clean state whenever the
      // failure is a catchable exception rather than a hard process crash.
      // Skipped if the blob somehow already exists (a concurrent put() for the
      // same content completed in the meantime) so we never delete a live row.
      if (!(await this.has(hash))) {
        await this.adapter!
          .executeRun('DELETE FROM blob_meta WHERE hash = ?', [hash])
          .catch((rollbackErr) => {
            console.error(
              '[blob-store] rollback of dangling blob_meta row failed for',
              hash,
              rollbackErr,
            );
          });
      }
      throw new BlobStoreSystemError(`write commit failed for ${hash}`, err as Error);
    }

    return hash;
  }

  async putStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    this.ensureOpen();
    const tempPath = this.allocateTempPath();
    const fileHandle = await fsp.open(tempPath, 'wx');
    const hashObj = createHash('sha256');
    let totalBytes = 0;
    const maxSize = this.config.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE;

    try {
      const reader = stream.getReader();
      const writeStream = fileHandle.createWriteStream();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxSize) {
            throw new BlobStoreSystemError(
              `blob exceeds maxBlobSize of ${maxSize}`,
            );
          }
          hashObj.update(value);
          writeStream.write(
            Buffer.from(value.buffer, value.byteOffset, value.byteLength),
          );
        }
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end((err: Error | null | undefined) =>
          err ? reject(err) : resolve(),
        );
      });
    } catch (err) {
      await fileHandle.close().catch(() => {});
      await fsp.unlink(tempPath).catch(() => {});
      throw err instanceof BlobStoreSystemError
        ? err
        : new BlobStoreSystemError('stream write failed', err as Error);
    }
    await fileHandle.close();

    const digest = hashObj.digest('hex');
    this.writeCount++;

    if (await this.has(digest)) {
      this.dedupSavings++;
      await fsp.unlink(tempPath).catch(() => {});
      return digest;
    }

    if (this.config.verifyOnWrite ?? false) {
      const result = await this.verifyPath(digest, tempPath);
      if (!result.match) {
        await fsp.unlink(tempPath).catch(() => {});
        throw new BlobStoreSystemError(
          `write-time integrity mismatch for ${digest}: expected ${digest}, computed ${result.computedHash}`,
        );
      }
    }

    // ── Write-order invariant — see put() for the full rationale. ──────────
    await this.upsertMeta(digest, totalBytes);

    const finalPath = this.blobPath(digest);

    try {
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      await fsp.rename(tempPath, finalPath);
    } catch (err) {
      await fsp.unlink(tempPath).catch(() => {});
      if (!(await this.has(digest))) {
        await this.adapter!
          .executeRun('DELETE FROM blob_meta WHERE hash = ?', [digest])
          .catch((rollbackErr) => {
            console.error(
              '[blob-store] rollback of dangling blob_meta row failed for',
              digest,
              rollbackErr,
            );
          });
      }
      throw new BlobStoreSystemError(`write commit failed for ${digest}`, err as Error);
    }

    return digest;
  }

  // ── Read ────────────────────────────────────────────────────────────────

  async get(hash: string): Promise<Uint8Array | null> {
    this.ensureOpen();
    const finalPath = this.blobPath(hash);
    try {
      const data = await fsp.readFile(finalPath);
      this.readCount++;

      if (this.config.verifyOnRead ?? true) {
        const computed = sha256Hex(data);
        if (computed !== hash) {
          throw new IntegrityMismatch(hash, hash, computed, data.byteLength);
        }
      }

      return data;
    } catch (err) {
      if (isNotFound(err)) return null;
      if (err instanceof IntegrityMismatch) throw err;
      throw new BlobStoreSystemError(
        `read failed for ${hash}`,
        err as Error,
      );
    }
  }

  async getStream(
    hash: string,
  ): Promise<ReadableStream<Uint8Array> | null> {
    this.ensureOpen();
    const finalPath = this.blobPath(hash);

    try {
      await fsp.access(finalPath);
    } catch {
      return null;
    }

    this.readCount++;
    const release = await this.fdGuard.acquire(hash);
    const verifyOnRead = this.config.verifyOnRead ?? true;
    let fileHandle: fsp.FileHandle | undefined;

    try {
      fileHandle = await fsp.open(finalPath, 'r');
      const fileSize = (await fileHandle.stat()).size;
      const hashObj = createHash('sha256');

      let cleanedUp = false;
      const cleanup = () => {
        if (!cleanedUp) {
          cleanedUp = true;
          clearTimeout(abandonTimer);
          release();
          fileHandle!.close().catch(() => {});
        }
      };

      // Safety net: force cleanup if stream is abandoned (never read, never cancelled).
      // Unref'd so it doesn't keep the process alive.
      const abandonTimer = setTimeout(() => {
        cleanup();
        console.warn(
          '[blob-store] stream abandoned, forced cleanup for',
          hash.slice(0, 8),
        );
      }, 60_000);
      abandonTimer.unref?.();

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const buf = Buffer.alloc(65536);
            const { bytesRead } = await fileHandle!.read(
              buf,
              0,
              65536,
              null,
            );
            if (bytesRead === 0) {
              if (verifyOnRead) {
                const computed = hashObj.digest('hex');
                if (computed !== hash) {
                  cleanup();
                  controller.error(
                    new IntegrityMismatch(hash, hash, computed, fileSize),
                  );
                  return;
                }
              }
              cleanup();
              controller.close();
              return;
            }
            const chunk = new Uint8Array(
              buf.buffer,
              buf.byteOffset,
              bytesRead,
            );
            hashObj.update(chunk);
            controller.enqueue(chunk);
          } catch (err) {
            cleanup();
            controller.error(err);
          }
        },
        cancel() {
          cleanup();
        },
      });
    } catch (err) {
      if (fileHandle) await fileHandle.close().catch(() => {});
      release();
      if (err instanceof IntegrityMismatch) throw err;
      if (isNotFound(err)) return null;
      throw new BlobStoreSystemError(
        `stream read failed for ${hash}`,
        err as Error,
      );
    }
  }

  // ── Existence ───────────────────────────────────────────────────────────

  async has(hash: string): Promise<boolean> {
    this.ensureOpen();
    try {
      await fsp.access(this.blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async exists(hash: string): Promise<boolean> {
    return this.has(hash);
  }

  // ── Deletion ────────────────────────────────────────────────────────────

  async delete(hash: string): Promise<boolean> {
    this.ensureOpen();
    if (this.gcInProgress) {
      throw new GCInProgress(this.gcStartedAt!);
    }
    if (!(await this.has(hash))) return false;

    const fp = this.blobPath(hash);
    try {
      // ── Write-order invariant (BUG-EPIC-BLOBSTORE-WRITE-ORDER-INVERSION-001) ──
      // The DB record is removed BEFORE the file. A crash between the two lines
      // below leaves an orphan file (no DB record) — reclaimable by GC / the
      // consistency-check repair path — rather than a dangling reference (DB
      // record, no file), which is unrecoverable: every subsequent read would
      // fail against a record that claims to exist.
      await this.adapter!.executeRun('DELETE FROM blob_meta WHERE hash = ?', [hash]);
      await fsp.unlink(fp);
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        // The DB record is already gone (deleted above) and the file is
        // already gone too (raced with a concurrent delete/GC) — end state is
        // fully consistent, so this call did accomplish a real deletion.
        return true;
      }
      throw new BlobStoreSystemError(
        `delete failed for ${hash}`,
        err as Error,
      );
    }
  }

  // ── Maintenance ─────────────────────────────────────────────────────────

  async count(): Promise<number> {
    this.ensureOpen();
    const dir = this.config.basePath;
    let total = 0;
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name === '.tmp' ||
          entry.name === '.lock' ||
          entry.name === 'refs.db'
        )
          continue;
        if (entry.isDirectory()) {
          const sub = await fsp.readdir(path.join(dir, entry.name));
          total += sub.length;
        }
      }
    } catch {
      // ignore — return 0
    }
    return total;
  }

  async totalSize(): Promise<number> {
    this.ensureOpen();
    const row = await this.adapter!.executeGet<{ total: number | null }>(
      'SELECT COALESCE(SUM(size), 0) as total FROM blob_meta',
    );
    return row?.total ?? 0;
  }

  async sizeOf(hash: string): Promise<number> {
    this.ensureOpen();
    const row = await this.adapter!.executeGet<{ size: number }>(
      'SELECT size FROM blob_meta WHERE hash = ?',
      [hash],
    );
    return row?.size ?? 0;
  }

  async *listBlobs(
    opts?: { prefix?: string; limit?: number; offset?: number },
  ): AsyncIterable<string> {
    this.ensureOpen();
    const base = this.config.basePath;
    const prefix = opts?.prefix ?? '';
    const limit = opts?.limit ?? Infinity;
    const offset = opts?.offset ?? 0;
    let count = 0;
    let skipped = 0;

    try {
      const entries = await fsp.readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.name === '.tmp' ||
          entry.name === '.lock'
        )
          continue;
        if (prefix && !entry.name.startsWith(prefix.slice(0, 2))) continue;

        const subDir = path.join(base, entry.name);
        const files = await fsp.readdir(subDir);
        for (const file of files) {
          if (prefix && !file.startsWith(prefix)) continue;
          if (skipped < offset) {
            skipped++;
            continue;
          }
          if (count >= limit) return;
          count++;
          yield file;
        }
      }
    } catch {
      // stop iteration
    }
  }

  // ── Export ──────────────────────────────────────────────────────────────

  async export(
    target: BlobStore,
    opts?: { filter?: (hash: string) => boolean },
  ): Promise<ExportStats> {
    const start = Date.now();
    let blobsCopied = 0;
    let bytesCopied = 0;
    let blobsSkipped = 0;

    for await (const hash of this.listBlobs()) {
      if (opts?.filter && !opts.filter(hash)) {
        blobsSkipped++;
        continue;
      }

      if (await target.has(hash)) {
        blobsSkipped++;
        continue;
      }

      const data = await this.get(hash);
      if (data) {
        await target.put(data);
        blobsCopied++;
        bytesCopied += data.byteLength;
      }
    }

    return {
      blobsCopied,
      bytesCopied,
      blobsSkipped,
      durationMs: Date.now() - start,
    };
  }

  // ── Metrics ─────────────────────────────────────────────────────────────

  async metrics(): Promise<BlobStoreMetrics> {
    this.ensureOpen();
    const orphanRow = await this.adapter!.executeGet<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM blob_meta b
       WHERE NOT EXISTS (SELECT 1 FROM refs r WHERE r.blob_hash = b.hash)`,
    );
    const orphanCount = orphanRow?.cnt ?? 0;
    const totalRow = await this.adapter!.executeGet<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM blob_meta',
    );
    const totalBlobs = totalRow?.cnt ?? 0;
    const bytesRow = await this.adapter!.executeGet<{ total: number | null }>(
      'SELECT COALESCE(SUM(size), 0) as total FROM blob_meta',
    );
    const totalBytes = bytesRow?.total ?? 0;

    return {
      totalBlobs,
      totalBytes,
      orphanCount,
      gcRuns: this.gcRuns,
      gcBytesFreed: this.gcBytesFreed,
      readCount: this.readCount,
      writeCount: this.writeCount,
      dedupSavings: this.dedupSavings,
    };
  }

  // ── Integrity ───────────────────────────────────────────────────────────

  async verify(hash: string): Promise<VerificationResult> {
    this.ensureOpen();
    const fp = this.blobPath(hash);
    try {
      const data = await fsp.readFile(fp);
      const computedHash = sha256Hex(data);
      return {
        hash,
        size: data.byteLength,
        computedHash,
        match: computedHash === hash,
        tVerified: new Date().toISOString(),
      };
    } catch (err) {
      if (isNotFound(err)) {
        throw new BlobNotFound(hash);
      }
      throw new BlobStoreSystemError(
        `verify failed for ${hash}`,
        err as Error,
      );
    }
  }

  async *verifyAll(
    opts?: {
      concurrency?: number;
      onCorrupt?: 'warn' | 'delete' | 'fail';
    },
  ): AsyncIterable<VerificationResult> {
    this.ensureOpen();
    const concurrency = opts?.concurrency ?? 4;
    const onCorrupt = opts?.onCorrupt ?? 'warn';
    const pending: Promise<VerificationResult>[] = [];

    for await (const hash of this.listBlobs()) {
      pending.push(this.verify(hash));

      if (pending.length >= concurrency) {
        const batch = pending.splice(0, concurrency);
        const settled = await Promise.allSettled(batch);
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            const result = s.value;
            if (!result.match) {
              if (onCorrupt === 'fail') {
                throw new IntegrityMismatch(
                  result.hash,
                  result.hash,
                  result.computedHash,
                  result.size,
                );
              }
              if (onCorrupt === 'delete') {
                await this.delete(result.hash).catch(() => {});
                console.warn(
                  '[blob-store] deleted corrupt blob:',
                  result.hash,
                );
              } else {
                console.warn(
                  '[blob-store] integrity mismatch for',
                  result.hash,
                  '(logged, not deleted)',
                );
              }
            }
            yield result;
          }
        }
      }
    }

    // Drain remaining
    while (pending.length > 0) {
      const batch = pending.splice(0, concurrency);
      const settled = await Promise.allSettled(batch);
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          const result = s.value;
          if (!result.match) {
            if (onCorrupt === 'fail') {
              throw new IntegrityMismatch(
                result.hash,
                result.hash,
                result.computedHash,
                result.size,
              );
            }
            if (onCorrupt === 'delete') {
              await this.delete(result.hash).catch(() => {});
            } else {
              console.warn(
                '[blob-store] integrity mismatch for',
                result.hash,
                '(logged, not deleted)',
              );
            }
          }
          yield result;
        }
      }
    }
  }

  // ── Consistency ─────────────────────────────────────────────────────────
  // Detects the two failure residues write-order inversions can leave behind
  // (BUG-EPIC-BLOBSTORE-WRITE-ORDER-INVERSION-001):
  //   - orphan:   a file on disk with no blob_meta row (safe — reclaimable)
  //   - dangling: a blob_meta row with no file on disk (dangerous — every
  //               read against it fails; must never be left unreclaimed)
  // This is a full directory scan cross-referenced against blob_meta, so it
  // finds orphans regardless of how they came to exist — unlike getOrphans(),
  // which is DB-driven and can never see a file with no DB row at all.

  async checkConsistency(): Promise<ConsistencyReport> {
    this.ensureOpen();

    const onDisk = new Set<string>();
    for await (const hash of this.listBlobs()) {
      onDisk.add(hash);
    }

    const dbRows = await this.adapter!.executeAll<{ hash: string; size: number }>(
      'SELECT hash, size FROM blob_meta',
    );
    const dbSizeByHash = new Map(dbRows.rows.map((r) => [r.hash, r.size]));

    const orphans: Array<{ hash: string; size: number }> = [];
    for (const hash of onDisk) {
      if (dbSizeByHash.has(hash)) continue;
      try {
        const stat = await fsp.stat(this.blobPath(hash));
        orphans.push({ hash, size: stat.size });
      } catch (err) {
        if (!isNotFound(err)) {
          console.error('[blob-store] checkConsistency: stat failed for', hash, err);
        }
        // File vanished between the directory scan and the stat (raced with a
        // concurrent delete/GC) — no longer an orphan, skip it.
      }
    }

    const dangling: Array<{ hash: string; size: number }> = [];
    for (const [hash, size] of dbSizeByHash) {
      if (!onDisk.has(hash)) {
        dangling.push({ hash, size });
      }
    }

    return {
      scannedAt: new Date().toISOString(),
      orphanCount: orphans.length,
      danglingCount: dangling.length,
      orphans,
      dangling,
    };
  }

  /**
   * Reclaims dangling blob_meta rows (record, no file) that are safe to
   * remove: zero refs point at them. addRef() requires has(hash) === true
   * (the file must already be present) before a ref can ever be created, so
   * a dangling row with zero refs can only be crash residue from an
   * interrupted put()/putStream() — never a live reference losing its data.
   *
   * Dangling rows WITH refs are never touched here: that shape means a ref
   * points at a blob that is genuinely gone (e.g. residue from write-order
   * inversions predating this fix, or manual corruption) and deleting the
   * record would silently hide real data loss. Those are reported via
   * `unreclaimed` for an operator to investigate.
   */
  async repairDangling(): Promise<RepairResult> {
    this.ensureOpen();
    const report = await this.checkConsistency();

    let reclaimed = 0;
    const unreclaimed: Array<{ hash: string; refCount: number }> = [];

    for (const { hash } of report.dangling) {
      const refs = await this.refCount(hash);
      if (refs > 0) {
        unreclaimed.push({ hash, refCount: refs });
        continue;
      }
      await this.adapter!.executeRun('DELETE FROM blob_meta WHERE hash = ?', [hash]);
      reclaimed++;
    }

    return { reclaimed, unreclaimed };
  }

  // ── Reference tracking ──────────────────────────────────────────────────

  async addRef(
    blobHash: string,
    referrer: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.ensureOpen();
    if (!(await this.has(blobHash))) throw new BlobNotFound(blobHash);
    const ctx = context ? JSON.stringify(context) : null;
    await this.adapter!.executeRun(
      `INSERT INTO refs(blob_hash, referrer, context) VALUES(?, ?, ?)
       ON CONFLICT(blob_hash, referrer) DO UPDATE SET
         t_touched = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         context = COALESCE(EXCLUDED.context, refs.context)`,
      [blobHash, referrer, ctx],
    );
  }

  async addRefs(
    blobHashes: string[],
    referrer: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.ensureOpen();
    const ctx = context ? JSON.stringify(context) : null;
    await this.adapter!.transaction(async (tx) => {
      for (const h of blobHashes) {
        const exists = await tx.executeGet(
          'SELECT 1 FROM blob_meta WHERE hash = ?',
          [h],
        );
        if (!exists) {
          throw new BlobNotFound(h);
        }
        await tx.executeRun(
          `INSERT INTO refs(blob_hash, referrer, context) VALUES(?, ?, ?)
           ON CONFLICT(blob_hash, referrer) DO UPDATE SET
             t_touched = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             context = COALESCE(EXCLUDED.context, refs.context)`,
          [h, referrer, ctx],
        );
      }
    });
  }

  async removeRef(blobHash: string, referrer: string): Promise<void> {
    this.ensureOpen();
    await this.adapter!.executeRun(
      'DELETE FROM refs WHERE blob_hash = ? AND referrer = ?',
      [blobHash, referrer],
    );
  }

  async removeAllRefs(referrer: string): Promise<void> {
    this.ensureOpen();
    await this.adapter!.executeRun(
      'DELETE FROM refs WHERE referrer = ?',
      [referrer],
    );
  }

  async getRefsForReferrer(referrer: string): Promise<string[]> {
    this.ensureOpen();
    const result = await this.adapter!.executeAll<{ blob_hash: string }>(
      'SELECT blob_hash FROM refs WHERE referrer = ?',
      [referrer],
    );
    return result.rows.map((r) => r.blob_hash);
  }

  async getReferrersForBlob(blobHash: string): Promise<string[]> {
    this.ensureOpen();
    const result = await this.adapter!.executeAll<{ referrer: string }>(
      'SELECT referrer FROM refs WHERE blob_hash = ?',
      [blobHash],
    );
    return result.rows.map((r) => r.referrer);
  }

  async refCount(blobHash: string): Promise<number> {
    this.ensureOpen();
    const row = await this.adapter!.executeGet<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM refs WHERE blob_hash = ?',
      [blobHash],
    );
    return row?.cnt ?? 0;
  }

  async getOrphans(
    opts?: {
      t_before?: string;
      limit?: number;
    },
  ): Promise<
    Array<{
      hash: string;
      size: number;
      lastRefRemoved: string | null;
    }>
  > {
    this.ensureOpen();
    const tBefore =
      opts?.t_before ?? new Date().toISOString();
    const limit = opts?.limit ?? 1000;

    const result = await this.adapter!.executeAll<{
      hash: string; size: number; lastRefRemoved: string | null;
    }>(
      `SELECT b.hash, b.size, MAX(r.t_created) as lastRefRemoved
       FROM blob_meta b
       LEFT JOIN refs r ON r.blob_hash = b.hash
       WHERE pinned = 0
         AND (r.blob_hash IS NULL
           OR (SELECT COUNT(*) FROM refs r2 WHERE r2.blob_hash = b.hash) = 0)
       GROUP BY b.hash
       HAVING lastRefRemoved IS NULL OR lastRefRemoved < ?
       LIMIT ?`,
      [tBefore, limit],
    );
    return result.rows;
  }

  // ── GC ──────────────────────────────────────────────────────────────────

  async gc(opts?: GCOpts): Promise<GcResult> {
    this.ensureOpen();
    if (this.gcInProgress) {
      throw new GCInProgress(this.gcStartedAt!);
    }
    this.gcInProgress = true;
    this.gcCancelled = false;
    this.gcStartedAt = new Date().toISOString();
    const tStart = Date.now();

    const lockFd = await this.acquireGcLock();
    try {
      const gracePeriodMs =
        opts?.gracePeriodMs ?? this.config.gc?.gracePeriodMs ?? 0;
      const maxDelete =
        opts?.maxDelete ??
        this.config.gc?.maxDeletePerCycle ??
        DEFAULT_GC_MAX_DELETE;
      const dryRun = opts?.dryRun ?? false;
      const tBefore = new Date(
        Date.now() - gracePeriodMs,
      ).toISOString();

      const orphans = await this.getOrphans({
        t_before: tBefore,
        limit: maxDelete * 2,
      });
      const candidates: GcBlobInfo[] = [];
      const errors: Array<{ hash: string; error: string }> = [];

      // Mark phase with progress
      for (let i = 0; i < orphans.length; i++) {
        if (this.gcCancelled) break;
        const o = orphans[i]!;
        if (this.fdGuard.isHeld(o.hash)) continue;

        // Double-check refs inside same SQLite txn
        const refCheck = await this.adapter!.executeGet<{ cnt: number }>(
          'SELECT COUNT(*) as cnt FROM refs WHERE blob_hash = ?',
          [o.hash],
        );
        if ((refCheck?.cnt ?? 0) > 0) continue;

        candidates.push({
          hash: o.hash,
          size: o.size,
          lastRefRemoved: o.lastRefRemoved,
          tCreated: '',
        });

        // Emit progress every 500 blobs
        if (i > 0 && i % 500 === 0) {
          this.emitGcProgress({
            phase: 'mark',
            processed: i,
            total: orphans.length,
            bytesScanned: candidates.reduce((s, c) => s + c.size, 0),
          });
        }
      }

      const totalOrphanBytes = candidates.reduce(
        (s, c) => s + c.size,
        0,
      );

      // Emit final mark progress
      this.emitGcProgress({
        phase: 'mark',
        processed: candidates.length,
        total: orphans.length,
        bytesScanned: totalOrphanBytes,
      });

      let deleted = 0;
      let bytesFreed = 0;

      // Sweep phase
      if (!dryRun) {
        for (let i = 0; i < candidates.length && i < maxDelete; i++) {
          if (this.gcCancelled) break;
          const c = candidates[i]!;

          try {
            // Double-check FD guard at sweep time
            if (this.fdGuard.isHeld(c.hash)) {
              console.debug(
                '[blob-store] gc: skipping',
                c.hash.slice(0, 8),
                '(fd held at sweep time)',
              );
              continue;
            }

            // ── Write-order invariant — see delete() for the full rationale. ──
            // DB record removed first: a crash mid-sweep leaves an orphan file
            // (reclaimable by the next GC/consistency-check pass), never a
            // dangling reference.
            const fp = this.blobPath(c.hash);
            await this.adapter!.executeRun(
              'DELETE FROM blob_meta WHERE hash = ?',
              [c.hash],
            );
            try {
              await fsp.unlink(fp);
            } catch (unlinkErr) {
              if (!isNotFound(unlinkErr)) throw unlinkErr;
              // File already gone (raced with a concurrent delete/GC) — the DB
              // record is already gone too, so the end state is consistent.
            }
            deleted++;
            bytesFreed += c.size;
          } catch (err) {
            errors.push({ hash: c.hash, error: String(err) });
          }

          // Emit sweep progress every 500 blobs
          if (i > 0 && i % 500 === 0) {
            this.emitGcProgress({
              phase: 'sweep',
              processed: i,
              total: Math.min(candidates.length, maxDelete),
              bytesScanned: bytesFreed,
            });
          }
        }

        // Emit final sweep progress
        this.emitGcProgress({
          phase: 'sweep',
          processed: deleted,
          total: Math.min(candidates.length, maxDelete),
          bytesScanned: bytesFreed,
        });
      }

      // Record GC run
      await this.adapter!.executeRun(
        `INSERT INTO gc_runs(t_started, t_ended, dry_run, blobs_marked, blobs_deleted, bytes_freed, error)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
        [
          this.gcStartedAt,
          new Date().toISOString(),
          dryRun ? 1 : 0,
          candidates.length,
          deleted,
          bytesFreed,
          errors.length > 0 ? JSON.stringify(errors) : null,
        ],
      );

      this.gcRuns++;
      this.gcBytesFreed += bytesFreed;

      console.info(
        `[blob-store] GC run complete: deleted ${deleted} blobs, freed ${bytesFreed} bytes${dryRun ? ' (dry-run)' : ''}`,
      );

      return {
        dryRun,
        tStarted: this.gcStartedAt,
        tEnded: new Date().toISOString(),
        durationMs: Date.now() - tStart,
        orphans: candidates,
        totalOrphanBytes,
        deleted,
        bytesFreed,
        errors,
      };
    } finally {
      await lockFd.close();
      this.gcInProgress = false;
      // Wake up any gcProgress() listeners stuck waiting
      this.emitGcProgress({ phase: 'mark', processed: 0, total: 0, bytesScanned: 0 });
      this.gcStartedAt = null;
    }
  }

  async *gcProgress(): AsyncIterable<{
    phase: 'mark' | 'sweep';
    processed: number;
    total: number;
    bytesScanned: number;
  }> {
    const queue: Array<{
      phase: 'mark' | 'sweep';
      processed: number;
      total: number;
      bytesScanned: number;
    }> = [];
    let resolve: (() => void) | null = null;

    const listener = (
      evt: {
        phase: 'mark' | 'sweep';
        processed: number;
        total: number;
        bytesScanned: number;
      },
    ) => {
      queue.push(evt);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    this.gcProgressListeners.push(listener);
    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        // If GC finished and queue is drained, stop
        if (!this.gcInProgress && queue.length === 0) break;
        // Wait for next event
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    } finally {
      const idx = this.gcProgressListeners.indexOf(listener);
      if (idx >= 0) this.gcProgressListeners.splice(idx, 1);
    }
  }

  async getGcHistory(
    opts?: { limit?: number; offset?: number },
  ): Promise<GcResult[]> {
    this.ensureOpen();
    const limit = opts?.limit ?? 10;
    const offset = opts?.offset ?? 0;
    const result = await this.adapter!.executeAll<GcResultRow>(
      `SELECT * FROM gc_runs ORDER BY id DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return result.rows.map((r) => ({
      dryRun: r.dry_run === 1,
      tStarted: r.t_started,
      tEnded: r.t_ended ?? '',
      durationMs: r.t_ended
        ? new Date(r.t_ended).getTime() -
          new Date(r.t_started).getTime()
        : 0,
      orphans: [],
      totalOrphanBytes: 0,
      deleted: r.blobs_deleted,
      bytesFreed: r.bytes_freed,
      errors: r.error ? JSON.parse(r.error) : [],
    }));
  }

  async cancelGc(): Promise<boolean> {
    if (!this.gcInProgress) return false;
    this.gcCancelled = true;
    return true;
  }

  // ── Pin / Unpin ─────────────────────────────────────────────────────────

  async pin(hash: string): Promise<void> {
    this.ensureOpen();
    if (!(await this.has(hash))) throw new BlobNotFound(hash);
    await this.adapter!.executeRun(
      'UPDATE blob_meta SET pinned = 1 WHERE hash = ?',
      [hash],
    );
  }

  async unpin(hash: string): Promise<void> {
    this.ensureOpen();
    await this.adapter!.executeRun(
      'UPDATE blob_meta SET pinned = 0 WHERE hash = ?',
      [hash],
    );
  }

  async isPinned(hash: string): Promise<boolean> {
    this.ensureOpen();
    const row = await this.adapter!.executeGet<{ pinned: number }>(
      'SELECT pinned FROM blob_meta WHERE hash = ?',
      [hash],
    );
    return row?.pinned === 1;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private ensureOpen(): void {
    if (!this._isOpen || !this.adapter) {
      throw new BlobStoreNotOpenError();
    }
  }

  private blobPath(hash: string): string {
    const prefix = hash.slice(0, 2);
    return path.join(this.config.basePath, prefix, hash);
  }

  private allocateTempPath(): string {
    const random = randomUUID().replace(/-/g, '').slice(0, 8);
    return path.join(
      this.resolvedTempDir,
      `tmp_${Date.now()}_${random}`,
    );
  }

  private async verifyPath(
    hash: string,
    filePath: string,
  ): Promise<VerificationResult> {
    const data = await fsp.readFile(filePath);
    const computed = sha256Hex(data);
    return {
      hash,
      size: data.byteLength,
      computedHash: computed,
      match: computed === hash,
      tVerified: new Date().toISOString(),
    };
  }

  private async upsertMeta(hash: string, size: number): Promise<void> {
    await this.adapter!.executeRun(
      `INSERT INTO blob_meta(hash, size) VALUES(?, ?)
       ON CONFLICT(hash) DO NOTHING`,
      [hash, size],
    );
  }

  private async cleanupOrphanedTemp(): Promise<void> {
    try {
      const files = await fsp.readdir(this.resolvedTempDir);
      for (const f of files) {
        if (f.startsWith('tmp_')) {
          await fsp
            .unlink(path.join(this.resolvedTempDir, f))
            .catch(() => {});
        }
      }
    } catch {
      // directory may not exist yet
    }
  }

  private async acquireGcLock(): Promise<{ close: () => void }> {
    const lockPath = path.join(this.config.basePath, '.lock');
    const timeoutMs = 30_000;
    const pollIntervalMs = 200;
    const start = Date.now();
    const lockFilePath = lockPath + '.acquire';

    // Ensure the lock directory exists (basePath already does)
    while (true) {
      try {
        const fd = await fsp.open(lockFilePath, 'wx');
        // Exclusive lock acquired — no other process holds this fd
        try {
          await fd.datasync();
        } catch {
          // best-effort
        }
        return {
          close: () => {
            fd.close().catch(() => {});
            fsp.unlink(lockFilePath).catch(() => {});
          },
        };
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'EEXIST') {
          if (Date.now() - start >= timeoutMs) {
            throw new BlobStoreSystemError('GC lock acquisition timed out');
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          continue;
        }
        throw new BlobStoreSystemError('GC lock acquisition failed', err as Error);
      }
    }
  }

  private emitGcProgress(evt: {
    phase: 'mark' | 'sweep';
    processed: number;
    total: number;
    bytesScanned: number;
  }): void {
    for (const listener of this.gcProgressListeners) {
      try {
        listener(evt);
      } catch {
        // ignore listener errors
      }
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createBlobStore(config: StoreConfig): BlobStore {
  const resolved: StoreConfig = {
    ...config,
    maxBlobSize: config.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE,
    verifyOnRead: config.verifyOnRead ?? true,
    verifyOnWrite: config.verifyOnWrite ?? false,
  };
  const store = new BlobStore();
  Object.defineProperty(store, 'config', { value: resolved, writable: false });
  return store;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}
