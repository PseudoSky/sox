// ── BlobStore — content-addressable blob storage ─────────────────────────────

import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

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
  private db: Database.Database | null = null;
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

    this.db = new (await import('better-sqlite3')).default(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    applySchema(this.db);

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
    if (this.db) {
      this.db.close();
      this.db = null;
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

    const finalPath = this.blobPath(hash);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });

    try {
      await fsp.rename(tempPath, finalPath);
    } catch {
      await fsp.unlink(tempPath).catch(() => {});
      throw new BlobStoreSystemError(`rename failed for ${hash}`);
    }

    if (this.config.verifyOnWrite ?? false) {
      const result = await this.verifyOnDisk(hash);
      if (!result.match) {
        await fsp.unlink(finalPath).catch(() => {});
        throw new BlobStoreSystemError(
          `write-time integrity mismatch for ${hash}: expected ${hash}, computed ${result.computedHash}`,
        );
      }
    }

    this.upsertMeta(hash, data.byteLength);
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

    const finalPath = this.blobPath(digest);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });

    try {
      await fsp.rename(tempPath, finalPath);
    } catch {
      await fsp.unlink(tempPath).catch(() => {});
      throw new BlobStoreSystemError(`rename failed for ${digest}`);
    }

    if (this.config.verifyOnWrite ?? false) {
      const result = await this.verifyOnDisk(digest);
      if (!result.match) {
        await fsp.unlink(finalPath).catch(() => {});
        throw new BlobStoreSystemError(
          `write-time integrity mismatch for ${digest}: expected ${digest}, computed ${result.computedHash}`,
        );
      }
    }

    this.upsertMeta(digest, totalBytes);
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
    const fp = this.blobPath(hash);
    try {
      await fsp.unlink(fp);
      this.db!.prepare('DELETE FROM blob_meta WHERE hash = ?').run(hash);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
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
    const row = this.db!
      .prepare<[], { total: number | null }>(
        'SELECT COALESCE(SUM(size), 0) as total FROM blob_meta',
      )
      .get();
    return row?.total ?? 0;
  }

  async sizeOf(hash: string): Promise<number> {
    this.ensureOpen();
    const row = this.db!
      .prepare<[string], { size: number }>(
        'SELECT size FROM blob_meta WHERE hash = ?',
      )
      .get(hash);
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

  metrics(): BlobStoreMetrics {
    const orphanCount = this.db
      ? (this.db
          .prepare<[], { cnt: number }>(
            `SELECT COUNT(*) as cnt FROM blob_meta b
             WHERE NOT EXISTS (SELECT 1 FROM refs r WHERE r.blob_hash = b.hash)`,
          )
          .get())?.cnt ?? 0
      : 0;
    const totalBlobs = this.db
      ? (this.db
          .prepare<[], { cnt: number }>(
            'SELECT COUNT(*) as cnt FROM blob_meta',
          )
          .get())?.cnt ?? 0
      : 0;
    const totalBytes = this.db
      ? (this.db
          .prepare<[], { total: number | null }>(
            'SELECT COALESCE(SUM(size), 0) as total FROM blob_meta',
          )
          .get())?.total ?? 0
      : 0;

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

  // ── Reference tracking ──────────────────────────────────────────────────

  async addRef(
    blobHash: string,
    referrer: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.ensureOpen();
    if (!(await this.has(blobHash))) throw new BlobNotFound(blobHash);
    const ctx = context ? JSON.stringify(context) : null;
    this.db!
      .prepare(
        `INSERT INTO refs(blob_hash, referrer, context) VALUES(?, ?, ?)
         ON CONFLICT(blob_hash, referrer) DO UPDATE SET
           t_touched = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           context = COALESCE(EXCLUDED.context, refs.context)`,
      )
      .run(blobHash, referrer, ctx);
  }

  async addRefs(
    blobHashes: string[],
    referrer: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.ensureOpen();
    const ctx = context ? JSON.stringify(context) : null;
    const txn = this.db!.transaction((hashes: string[]) => {
      for (const h of hashes) {
        if (
          !this.db!
            .prepare('SELECT 1 FROM blob_meta WHERE hash = ?')
            .get(h)
        ) {
          throw new BlobNotFound(h);
        }
        this.db!
          .prepare(
            `INSERT INTO refs(blob_hash, referrer, context) VALUES(?, ?, ?)
             ON CONFLICT(blob_hash, referrer) DO UPDATE SET
               t_touched = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               context = COALESCE(EXCLUDED.context, refs.context)`,
          )
          .run(h, referrer, ctx);
      }
    });
    txn(blobHashes);
  }

  async removeRef(blobHash: string, referrer: string): Promise<void> {
    this.ensureOpen();
    this.db!
      .prepare(
        'DELETE FROM refs WHERE blob_hash = ? AND referrer = ?',
      )
      .run(blobHash, referrer);
  }

  async removeAllRefs(referrer: string): Promise<void> {
    this.ensureOpen();
    this.db!
      .prepare('DELETE FROM refs WHERE referrer = ?')
      .run(referrer);
  }

  async getRefsForReferrer(referrer: string): Promise<string[]> {
    this.ensureOpen();
    const rows = this.db!
      .prepare<[string], { blob_hash: string }>(
        'SELECT blob_hash FROM refs WHERE referrer = ?',
      )
      .all(referrer);
    return rows.map((r) => r.blob_hash);
  }

  async getReferrersForBlob(blobHash: string): Promise<string[]> {
    this.ensureOpen();
    const rows = this.db!
      .prepare<[string], { referrer: string }>(
        'SELECT referrer FROM refs WHERE blob_hash = ?',
      )
      .all(blobHash);
    return rows.map((r) => r.referrer);
  }

  async refCount(blobHash: string): Promise<number> {
    this.ensureOpen();
    const row = this.db!
      .prepare<[string], { cnt: number }>(
        'SELECT COUNT(*) as cnt FROM refs WHERE blob_hash = ?',
      )
      .get(blobHash);
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

    const rows = this.db!
      .prepare<
        [string, number],
        { hash: string; size: number; lastRefRemoved: string | null }
      >(
        `SELECT b.hash, b.size, MAX(r.t_created) as lastRefRemoved
         FROM blob_meta b
         LEFT JOIN refs r ON r.blob_hash = b.hash
         WHERE pinned = 0
           AND (r.blob_hash IS NULL
             OR (SELECT COUNT(*) FROM refs r2 WHERE r2.blob_hash = b.hash) = 0)
         GROUP BY b.hash
         HAVING lastRefRemoved IS NULL OR lastRefRemoved < ?
         LIMIT ?`,
      )
      .all(tBefore, limit);
    return rows;
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
        const refCheck = this.db!
          .prepare<[string], { cnt: number }>(
            'SELECT COUNT(*) as cnt FROM refs WHERE blob_hash = ?',
          )
          .get(o.hash);
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

            const fp = this.blobPath(c.hash);
            await fsp.unlink(fp);
            this.db!
              .prepare('DELETE FROM blob_meta WHERE hash = ?')
              .run(c.hash);
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
      this.db!
        .prepare(
          `INSERT INTO gc_runs(t_started, t_ended, dry_run, blobs_marked, blobs_deleted, bytes_freed, error)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.gcStartedAt,
          new Date().toISOString(),
          dryRun ? 1 : 0,
          candidates.length,
          deleted,
          bytesFreed,
          errors.length > 0 ? JSON.stringify(errors) : null,
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
    const rows = this.db!
      .prepare<[number, number], GcResultRow>(
        `SELECT * FROM gc_runs ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
    return rows.map((r) => ({
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
    this.db!
      .prepare('UPDATE blob_meta SET pinned = 1 WHERE hash = ?')
      .run(hash);
  }

  async unpin(hash: string): Promise<void> {
    this.ensureOpen();
    this.db!
      .prepare('UPDATE blob_meta SET pinned = 0 WHERE hash = ?')
      .run(hash);
  }

  async isPinned(hash: string): Promise<boolean> {
    this.ensureOpen();
    const row = this.db!
      .prepare<[string], { pinned: number }>(
        'SELECT pinned FROM blob_meta WHERE hash = ?',
      )
      .get(hash);
    return row?.pinned === 1;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private ensureOpen(): void {
    if (!this._isOpen || !this.db) {
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

  private async verifyOnDisk(
    hash: string,
  ): Promise<VerificationResult> {
    const fp = this.blobPath(hash);
    const data = await fsp.readFile(fp);
    const computed = sha256Hex(data);
    return {
      hash,
      size: data.byteLength,
      computedHash: computed,
      match: computed === hash,
      tVerified: new Date().toISOString(),
    };
  }

  private upsertMeta(hash: string, size: number): void {
    this.db!
      .prepare(
        `INSERT INTO blob_meta(hash, size) VALUES(?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(hash, size);
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
