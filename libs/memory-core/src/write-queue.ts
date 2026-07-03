/**
 * In-process write queue — single FIFO queue per store path.
 *
 * CONTRACTS §C:
 *   - Every mutation routes through ONE in-process write queue (single connection,
 *     FIFO, group commit permitted).
 *   - Queue overflow → E_BUSY {retryable:true, retry_after_ms:250}.
 *   - The single write connection uses PRAGMA busy_timeout=3000, journal_mode=WAL,
 *     synchronous=NORMAL.
 *   - Read-only connections additionally set query_only=ON.
 *
 * The queue guarantees write serialization within a single process. Cross-process
 * serialization is the writer lease's responsibility (§J, context 03).
 */

import Database from 'better-sqlite3';
import { openDb } from './db.js';

// ── Error types (partial; full taxonomy is WP-2 / CONTRACTS §B) ───────────────

export interface QueueBusyError {
  code: 'E_BUSY';
  message: string;
  retryable: true;
  retry_after_ms: number;
}

export type QueueError = QueueBusyError;

// ── Queue internals ───────────────────────────────────────────────────────────

interface QueueItem<T = unknown> {
  label: string;
  /** The operation to execute. Can be sync or async; runs under the queue's write connection. */
  operation: (db: Database.Database) => T | Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
}

const DEFAULT_MAX_QUEUE_SIZE = 100;

/**
 * Single-writer queue for a given store path.
 * Only one WriteQueue exists per resolved dbPath — call `forPath()` to obtain it.
 *
 * Operations execute sequentially (FIFO). Async operations are serialised:
 * the next item does not start until the previous item's promise settles.
 * For embedding-heavy writes, perform the embedding BEFORE enqueuing and pass a
 * synchronous operation — this keeps the queue slot short and throughput high.
 */
export class WriteQueue {
  /** Singleton instances keyed by resolved (tilde-expanded) dbPath. */
  private static instances = new Map<string, WriteQueue>();

  private db: Database.Database;
  private queue: Array<QueueItem<any>> = [];
  private _processing = false;
  private _maxSize: number;
  private _runningPromise: Promise<void> = Promise.resolve();

  private constructor(dbPath: string, maxSize = DEFAULT_MAX_QUEUE_SIZE) {
    // Open a dedicated write connection with the mandated pragmas.
    this.db = openDb(dbPath);
    // Override busy_timeout per CONTRACTS §C (openDb currently uses 5000, but
    // schema.ts PRAGMAS have been updated to 3000 — this is a belt-and-suspenders).
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this._maxSize = maxSize;
  }

  /**
   * Obtain (or create) the WriteQueue for a resolved store path.
   * The returned queue is a singleton — repeated calls return the same instance.
   */
  static forPath(dbPath: string, maxSize?: number): WriteQueue {
    let instance = WriteQueue.instances.get(dbPath);
    if (!instance) {
      instance = new WriteQueue(dbPath, maxSize);
      WriteQueue.instances.set(dbPath, instance);
    }
    return instance;
  }

  /** Number of pending items (0 when idle). */
  get pending(): number {
    return this.queue.length;
  }

  /** True when the queue is actively processing an item. */
  get processing(): boolean {
    return this._processing;
  }

  /** Configured max queue depth. */
  get maxSize(): number {
    return this._maxSize;
  }

  /**
   * Enqueue a write operation.
   * The operation receives the queue's dedicated write connection.
   * Operations run sequentially (FIFO). Sync operations are preferred for
   * throughput; async operations are supported but hold the queue slot open
   * until their promise settles.
   *
   * When the queue is full, returns a rejected promise with E_BUSY.
   */
  enqueue<T>(
    label: string,
    operation: (db: Database.Database) => T | Promise<T>,
  ): Promise<T> {
    // Overflow guard
    if (this.queue.length >= this._maxSize) {
      return Promise.reject({
        code: 'E_BUSY',
        message: `Write queue for ${this.db.name} is full (${this._maxSize} pending)`,
        retryable: true,
        retry_after_ms: 250,
      } satisfies QueueBusyError);
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, operation, resolve, reject });
      if (!this._processing) {
        this._processing = true;
        // Chain onto the running promise to serialise async operations.
        this._runningPromise = this._runningPromise.then(() => this._processNext());
      }
    });
  }

  /**
   * Drain all pending items and close the database connection.
   * Resolves when the queue is empty and the connection is closed.
   */
  async drainAndClose(): Promise<void> {
    // Wait for the processing chain to finish
    while (this._processing || this.queue.length > 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    this.db.close();
    // Remove from the singleton map
    for (const [key, val] of WriteQueue.instances) {
      if (val === this) {
        WriteQueue.instances.delete(key);
        break;
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _processNext(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        const result = item.operation(this.db);
        // Await in case it's a promise (async operation). For sync operations,
        // this resolves immediately on the same microtask tick.
        const resolved = await result;
        item.resolve(resolved);
      } catch (err) {
        item.reject(err);
      }
    }
    this._processing = false;
  }
}
