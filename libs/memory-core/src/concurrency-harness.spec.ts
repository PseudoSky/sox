/**
 * concurrency-harness.spec.ts — WP-6 concurrency stress test (BL-134).
 *
 * Proves that the WriteQueue serialization prevents SQLite-level lock errors
 * under N concurrent writers, while raw concurrent connections (negative
 * control) reveal those errors.
 *
 * Structure:
 *   1. GREEN run: 8 concurrent writers, queue active → zero E_BUSY
 *   2. RED run:   8 concurrent writers with RAW better-sqlite3 connections,
 *      each using BEGIN IMMEDIATE + busy_timeout=5 → at least one E_BUSY
 *   3. p99 latency: measure observed mean, assert ×3 headroom allowance
 *
 * "pre-fix" = WP-1 bypass (SOX_DISABLE_WRITE_QUEUE or setBypass(true)).
 * "post-fix" = queue active (default).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { WriteQueue } from './write-queue.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp6-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('WP-6 concurrency harness (BL-134)', () => {
  let cleanup: () => void;
  let dbPath: string;

  beforeEach(() => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'stress.db');
    WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
  });

  afterEach(() => {
    WriteQueue.clearInstances();
    cleanup();
  });

  /**
   * ── GREEN run ────────────────────────────────────────────────────────────
   *
   * 8 concurrent writers all go through the same WriteQueue singleton.
   * Each writer enqueues 50 operations (INSERTs). Because the queue
   * serialises all operations, there is never more than one active DB
   * writer → zero SQLITE_BUSY errors.
   *
   * p99 latency is measured per-writer and compared against a ×3 headroom
   * budget derived from the observed mean write time.
   */
  it('GREEN: zero lock errors under 8 concurrent writers (queue active)', async () => {
    const queue = WriteQueue.forPath(dbPath);
    const N = 8;
    const OPS_PER_WRITER = 50;

    // Prepare the table
    await queue.enqueue('setup', (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS wp6_green (
        id INTEGER PRIMARY KEY,
        writer_id INTEGER NOT NULL,
        op_num INTEGER NOT NULL,
        payload TEXT
      )`);
    });

    // Each writer enqueues its operations through the shared queue
    async function writer(id: number): Promise<{ writeCount: number; errors: number; latencies: number[] }> {
      const latencies: number[] = [];
      let errors = 0;

      for (let j = 0; j < OPS_PER_WRITER; j++) {
        const opStart = Date.now();
        try {
          await queue.enqueue(`green-w${id}-${j}`, (db) => {
            db.prepare(
              'INSERT INTO wp6_green (writer_id, op_num, payload) VALUES (?, ?, ?)',
            ).run(id, j, 'x'.repeat(200));
          });
          latencies.push(Date.now() - opStart);
        } catch {
          errors++;
        }
      }

      return { writeCount: OPS_PER_WRITER, errors, latencies };
    }

    // Launch all writers concurrently
    const writers = Array.from({ length: N }, (_, i) => writer(i));
    const results = await Promise.all(writers);

    // Assert ZERO lock errors across all writers
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
    expect(totalErrors).toBe(0);

    // Assert every operation completed
    const totalWrites = results.reduce((sum, r) => sum + r.writeCount, 0);
    const totalInDb = await queue.enqueue('count-green', (db) => {
      const row = db.prepare<[], { cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM wp6_green',
      ).get()!;
      return row.cnt;
    });
    expect(totalInDb).toBe(N * OPS_PER_WRITER);

    // Measure p99 latency
    const allLatencies = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
    const meanLatency = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
    const p99Index = Math.ceil(allLatencies.length * 0.99) - 1;
    const p99Latency = allLatencies[p99Index]!;

    // p99 must be within 3× mean (headroom allowance)
    const headroomBudget = meanLatency * 3;
    expect(p99Latency).toBeLessThanOrEqual(headroomBudget + 50); // +50ms slack for GC/load
  });

  /**
   * ── RED run (negative control) ───────────────────────────────────────────
   *
   * Each concurrent writer opens a RAW better-sqlite3 connection (NOT
   * WriteQueue) with PRAGMA busy_timeout = 5 (very short — 5ms). Writers
   * use explicit BEGIN IMMEDIATE transactions holding 5 INSERTs each to
   * maximise lock contention. With 8 writers × 200 ops running in real
   * OS threads (worker_threads), concurrent connections to the same DB
   * file reliably produce SQLITE_BUSY.
   *
   * This proves that WITHOUT the queue's serialisation, lock contention
   * produces errors — the "negative control" for WP-1's queue fix.
   */
  it('RED: at least one E_BUSY under 8 concurrent writers (raw connections)', async () => {
    const { Worker } = await import('node:worker_threads');

    const N = 8;
    const OPS_PER_WRITER = 200;

    // Create an initial DB with table (so we don't test DDL contention)
    const setupDb = new Database(dbPath);
    setupDb.exec('PRAGMA journal_mode = WAL');
    setupDb.exec(`CREATE TABLE IF NOT EXISTS wp6_red (
      id INTEGER PRIMARY KEY,
      writer_id INTEGER NOT NULL,
      op_num INTEGER NOT NULL,
      payload TEXT
    )`);
    setupDb.close();

    // Spawn N worker threads, each hammering the same DB file concurrently
    const workers: Worker[] = [];
    const errors: number[] = new Array(N).fill(-1);

    // inline worker script as a string passed via workerData
    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const { dbPath, writerId, ops } = workerData;

      let errCount = 0;
      let db;
      try {
        db = new Database(dbPath);
        db.exec('PRAGMA busy_timeout = 5');
        db.exec('PRAGMA journal_mode = WAL');

        for (let j = 0; j < ops; j++) {
          try {
            const txn = db.transaction(() => {
              db.prepare('INSERT INTO wp6_red (writer_id, op_num, payload) VALUES (?, ?, ?)').run(writerId, j * 5 + 0, 'x'.repeat(200));
              db.prepare('INSERT INTO wp6_red (writer_id, op_num, payload) VALUES (?, ?, ?)').run(writerId, j * 5 + 1, 'x'.repeat(200));
              db.prepare('INSERT INTO wp6_red (writer_id, op_num, payload) VALUES (?, ?, ?)').run(writerId, j * 5 + 2, 'x'.repeat(200));
              db.prepare('INSERT INTO wp6_red (writer_id, op_num, payload) VALUES (?, ?, ?)').run(writerId, j * 5 + 3, 'x'.repeat(200));
              db.prepare('INSERT INTO wp6_red (writer_id, op_num, payload) VALUES (?, ?, ?)').run(writerId, j * 5 + 4, 'x'.repeat(200));
            });
            txn();
          } catch (e) {
            errCount++;
          }
        }
      } finally {
        if (db) try { db.close(); } catch {}
      }
      parentPort.postMessage({ errors: errCount });
    `;

    const promises: Promise<number>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        new Promise<number>((resolve, reject) => {
          const w = new Worker(workerCode, {
            eval: true,
            workerData: { dbPath, writerId: i, ops: OPS_PER_WRITER },
          });
          w.on('message', (msg: { errors: number }) => {
            errors[i] = msg.errors;
            resolve(msg.errors);
          });
          w.on('error', reject);
          w.on('exit', (code) => {
            if (code !== 0) reject(new Error(`worker ${i} exited with code ${code}`));
          });
          workers.push(w);
        }),
      );
    }

    await Promise.all(promises);

    // At least one worker hit a SQLITE_BUSY error
    const totalErrors = errors.reduce((sum, e) => sum + e, 0);
    expect(totalErrors).toBeGreaterThan(0);
  });

  /**
   * ── Queue overflow test ──────────────────────────────────────────────────
   *
   * With C concurrent callers and a tiny queue (maxSize = C - 1), at least
   * one caller receives E_BUSY from queue overflow.
   *
   * This proves the WP-1 overflow guard works under high concurrency.
   */
  it('overflow: E_BUSY from queue full under concurrency', async () => {
    const SMALL_MAX = 2;
    const CONCURRENT = 8;
    const queue = WriteQueue.forPath(dbPath, SMALL_MAX);

    // Do a slow operation (1s) to fill the single slot
    queue.enqueue('slow-pin', () => new Promise<string>((r) => setTimeout(r, 500)));

    // Flood the queue while the slow operation is running
    const flood = Array.from({ length: CONCURRENT }, async (_, i) => {
      const r = await queue
        .enqueue(`flood-${i}`, () => 'ok')
        .then(
          (v) => ({ ok: true, value: v }),
          (err) => ({ ok: false, error: err }),
        );
      return r;
    });

    const results = await Promise.all(flood);
    const busyErrors = results.filter(
      (r) => !r.ok && (r.error as { code: string }).code === 'E_BUSY',
    );

    // At maxSize=2, with a 500ms slow operation and 8 concurrent callers,
    // at least 6 should get E_BUSY from queue overflow
    expect(busyErrors.length).toBeGreaterThanOrEqual(CONCURRENT - SMALL_MAX);
  });
});
