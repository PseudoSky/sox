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
import { wrapDbError } from './errors.js';

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
 *
 * WP-1 negative control: set `SOX_DISABLE_WRITE_QUEUE=1` to bypass queue
 * serialisation (operations execute immediately, unordered). The queue ordering
 * test goes red under this flag.
 */
export class WriteQueue {
  /** Singleton instances keyed by resolved (tilde-expanded) dbPath. */
  private static instances = new Map<string, WriteQueue>();
  /** WP-1 negative control: when true, enqueue runs operations immediately (serialisation broken). */
  private static _bypass = !!process.env['SOX_DISABLE_WRITE_QUEUE'];

  private db: Database.Database;
  private queue: Array<QueueItem<any>> = [];
  private _processing = false;
  private _maxSize: number;
  private _runningPromise: Promise<void> = Promise.resolve();
  /** (WP-3) Instrumentation: number of items enqueued since last reset. Used in tests
   *  to assert that a batch write creates exactly one queue entry. */
  _enqueueCount = 0;

  private constructor(dbPath: string, maxSize = DEFAULT_MAX_QUEUE_SIZE) {
    // Open a dedicated write connection with the mandated pragmas.
    this.db = openDb(dbPath);
    // Override busy_timeout per CONTRACTS §C (openDb currently uses 5000, but
    // schema.ts PRAGMAS have been updated to 3000 — this is a belt-and-suspenders).
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this._maxSize = maxSize;
  }

  /**
   * Enable or disable queue bypass (WP-1 negative control).
   * In tests, set bypass=true and verify the ordering test fails.
   */
  static setBypass(enabled: boolean): void {
    WriteQueue._bypass = enabled;
  }

  /** True when the queue bypass is active (no serialisation). */
  static get bypass(): boolean {
    return WriteQueue._bypass;
  }

  /** (WP-3) Reset enqueueCount for all known queue instances. Used in test setup. */
  static resetAllEnqueueCounts(): void {
    for (const [, q] of WriteQueue.instances) {
      q._enqueueCount = 0;
    }
  }

  /**
   * Clear all singleton instances (test teardown).
   * Ensures each test gets a fresh queue.
   */
  static clearInstances(): void {
    for (const [, q] of WriteQueue.instances) {
      try { q.db.close(); } catch { /* already closed */ }
    }
    WriteQueue.instances.clear();
  }

  /**
   * Obtain (or create) the WriteQueue for a resolved store path.
   * The returned queue is a singleton — repeated calls return the same instance.
   * When `_bypass` is true, creates a new queue each time (no serialisation) so
   * the ordering negative control works.
   */
  static forPath(dbPath: string, maxSize?: number): WriteQueue {
    if (WriteQueue._bypass) {
      return new WriteQueue(dbPath, maxSize);
    }
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
    // WP-1 negative control: bypass queue → execute immediately (no serialisation)
    if (WriteQueue._bypass) {
      try {
        const result = operation(this.db);
        return Promise.resolve(result instanceof Promise ? result : Promise.resolve(result)).then(
          (v) => Promise.resolve(v),
        );
      } catch (err) {
        return Promise.reject(err);
      }
    }

    this._enqueueCount++;

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
        // WP-2: wrap raw SqliteError into CONTRACTS §B shape before surfacing.
        item.reject(wrapDbError(err));
      }
    }
    this._processing = false;
  }
}
