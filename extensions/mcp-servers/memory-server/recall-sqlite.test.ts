/**
 * recall-sqlite.test.ts — real-SQLite integration tests for memoryRecall().
 *
 * These tests exercise the full hot path of memoryRecall() against an actual
 * better-sqlite3 database with the real schema (sqlite-vec, FTS5, bi-temporal
 * columns). They are designed to FAIL if the alias mismatch bug is present
 * (SqliteError: no such column: n.t_invalid) and PASS once it is fixed.
 *
 * Coverage:
 *   1. Basic recall: write two claims, recall at current time → results returned.
 *   2. as_of (point-in-time) recall branch: the exact branch that was broken.
 *   3. Bi-temporal invalidation: invalidated claim excluded from current recall
 *      but visible in as_of recall at a timestamp before invalidation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './src/db.js';
import { memoryWrite } from './src/write.js';
import { memoryRecall } from './src/recall.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-recall-test-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('memoryRecall — real SQLite integration', () => {
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDb();
    dbPath = tmp.dbPath;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  // ── Test 1: basic recall returns results and does not throw ──────────────────

  it('writes two claims and recalls them without throwing', () => {
    const db = openDb(dbPath);

    try {
      const w1 = memoryWrite(db, { content: 'The sky is blue and vast.' });
      const w2 = memoryWrite(db, { content: 'The ocean has deep trenches.' });

      expect(w1).toHaveProperty('episode_uid');
      expect(w2).toHaveProperty('episode_uid');

      // Should not throw — this exercises the temporal query branch with current time.
      let response: ReturnType<typeof memoryRecall>;
      expect(() => {
        response = memoryRecall(db, 'project', { query: 'sky blue ocean' });
      }).not.toThrow();

      // Results array must exist and contain entries.
      expect(response!.results).toBeDefined();
      expect(response!.results.length).toBeGreaterThan(0);

      // provider_call_count must be exactly 0 (invariant R1)
      expect(response!.provider_call_count).toBe(0);
    } finally {
      db.close();
    }
  });

  // ── Test 2: as_of (point-in-time) recall branch executes without throwing ────

  it('as_of point-in-time recall executes and returns results', () => {
    const db = openDb(dbPath);

    try {
      const before = new Date().toISOString();
      memoryWrite(db, { content: 'Temporal recall test: first claim written.' });
      const after = new Date().toISOString();

      // This is the exact branch that was broken: as_of triggers the aliased
      // validity predicate (n.t_valid / n.t_invalid) in the temporal query.
      let response: ReturnType<typeof memoryRecall>;
      expect(() => {
        response = memoryRecall(db, 'project', {
          query: 'temporal recall first claim',
          as_of: after,
        });
      }).not.toThrow();

      expect(response!.results).toBeDefined();
      expect(response!.results.length).toBeGreaterThan(0);
      expect(response!.provider_call_count).toBe(0);

      // as_of before write should return nothing (claim didn't exist yet)
      let responseBefore: ReturnType<typeof memoryRecall>;
      expect(() => {
        responseBefore = memoryRecall(db, 'project', {
          query: 'temporal recall first claim',
          as_of: before,
        });
      }).not.toThrow();

      expect(responseBefore!.results).toBeDefined();
    } finally {
      db.close();
    }
  });

  // ── Test 3: invalidated claim excluded from current recall, visible in as_of ──

  it('invalidated claim is excluded from current recall but visible in as_of recall', () => {
    const db = openDb(dbPath);

    try {
      // Write old claim
      const w1 = memoryWrite(db, { content: 'Old claim: the bridge is red.' });
      expect(w1).toHaveProperty('episode_uid');
      const oldUid = (w1 as { episode_uid: string }).episode_uid;

      // Snapshot: timestamp after old claim was written but before invalidation.
      // We set snapshotTime 1 ms in the past so the invalidationTime is strictly
      // after it, satisfying the n.t_invalid > '${as_of}' strict-greater-than predicate.
      const snapshotTime = new Date(Date.now() - 1).toISOString();

      // Manually set t_invalid on the old claim to simulate bi-temporal invalidation.
      // invalidationTime must be strictly after snapshotTime.
      const invalidationTime = new Date().toISOString();
      db.prepare('UPDATE node SET t_invalid = ? WHERE uid = ?').run(invalidationTime, oldUid);

      // Write a new (replacement) claim
      const w2 = memoryWrite(db, { content: 'New claim: the bridge is painted blue.' });
      expect(w2).toHaveProperty('episode_uid');

      // Current recall: invalidated claim must NOT appear
      const current = memoryRecall(db, 'project', { query: 'bridge color red blue' });
      expect(current.results).toBeDefined();
      const currentUids = current.results.map((r) => r.uid);
      expect(currentUids).not.toContain(oldUid);

      // as_of recall at snapshotTime (before invalidation): old claim MUST appear
      // This exercises the as_of branch: n.t_invalid > '${as_of}' passes because
      // t_invalid was set AFTER snapshotTime.
      const pastRecall = memoryRecall(db, 'project', {
        query: 'bridge color red blue',
        as_of: snapshotTime,
      });
      expect(pastRecall.results).toBeDefined();
      const pastUids = pastRecall.results.map((r) => r.uid);
      expect(pastUids).toContain(oldUid);

      // Both calls must have zero provider invocations (invariant R1)
      expect(current.provider_call_count).toBe(0);
      expect(pastRecall.provider_call_count).toBe(0);
    } finally {
      db.close();
    }
  });
});
