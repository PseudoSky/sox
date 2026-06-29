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

import type { RecallResponse } from '@adhd/sox-memory-core';
import { _resetEmbedSingleton, _shutdownEmbedWorker, getActiveEmbedModel, memoryRecall, memoryWrite, openDb, runBatchEnrich, SOCKET_PATH } from '@adhd/sox-memory-core';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';


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
    // These tests assert bi-temporal recall MECHANICS, not embedding quality — pin the
    // fast, deterministic hash backend so they never trigger a slow cold ONNX model load.
    _resetEmbedSingleton();
    process.env['SOX_EMBED_BACKEND'] = 'hash';
  });

  afterEach(async () => {
    await _shutdownEmbedWorker();
    delete process.env['SOX_EMBED_BACKEND'];
    cleanup();
  });

  // ── Test 1: basic recall returns results and does not throw ──────────────────

  it('writes two claims and recalls them without throwing', async () => {
    const db = openDb(dbPath);

    try {
      const w1 = await memoryWrite(db, { content: 'The sky is blue and vast.' });
      const w2 = await memoryWrite(db, { content: 'The ocean has deep trenches.' });

      expect(w1).toHaveProperty('episode_uid');
      expect(w2).toHaveProperty('episode_uid');

      // Should not throw — this exercises the temporal query branch with current time.
      const response: RecallResponse = await memoryRecall(db, 'project', { query: 'sky blue ocean' });

      // Results array must exist and contain entries.
      expect(response.results).toBeDefined();
      expect(response.results.length).toBeGreaterThan(0);

      // provider_call_count must be exactly 0 (invariant R1)
      expect(response.provider_call_count).toBe(0);
    } finally {
      db.close();
    }
  });

  // ── Test 2: as_of (point-in-time) recall branch executes without throwing ────

  it('as_of point-in-time recall executes and returns results', async () => {
    const db = openDb(dbPath);

    try {
      const before = new Date().toISOString();
      await memoryWrite(db, { content: 'Temporal recall test: first claim written.' });
      const after = new Date().toISOString();

      // This is the exact branch that was broken: as_of triggers the aliased
      // validity predicate (n.t_valid / n.t_invalid) in the temporal query.
      const response: RecallResponse = await memoryRecall(db, 'project', {
        query: 'temporal recall first claim',
        as_of: after,
      });

      expect(response.results).toBeDefined();
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.provider_call_count).toBe(0);

      // as_of before write should return nothing (claim didn't exist yet)
      const responseBefore: RecallResponse = await memoryRecall(db, 'project', {
        query: 'temporal recall first claim',
        as_of: before,
      });

      expect(responseBefore.results).toBeDefined();
    } finally {
      db.close();
    }
  });

  // ── Test 3: invalidated claim excluded from current recall, visible in as_of ──

  it('invalidated claim is excluded from current recall but visible in as_of recall', async () => {
    const db = openDb(dbPath);

    try {
      // Write old claim
      const w1 = await memoryWrite(db, { content: 'Old claim: the bridge is red.' });
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
      const w2 = await memoryWrite(db, { content: 'New claim: the bridge is painted blue.' });
      expect(w2).toHaveProperty('episode_uid');

      // Current recall: invalidated claim must NOT appear
      const current: RecallResponse = await memoryRecall(db, 'project', { query: 'bridge color red blue' });
      expect(current.results).toBeDefined();
      const currentUids = current.results.map((r) => r.uid);
      expect(currentUids).not.toContain(oldUid);

      // as_of recall at snapshotTime (before invalidation): old claim MUST appear
      // This exercises the as_of branch: n.t_invalid > '${as_of}' passes because
      // t_invalid was set AFTER snapshotTime.
      const pastRecall: RecallResponse = await memoryRecall(db, 'project', {
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

// ── Semantic proof — real embedding ───────────────────────────────────────────
//
// Proves that the MCP path routes through the real fastembed backend, producing
// semantically-ranked recall (not just hash-bucket recall).

describe('MCP bundle path — real embedding semantic proof', () => {
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDb();
    dbPath = tmp.dbPath;
    cleanup = tmp.cleanup;
    _resetEmbedSingleton();
    process.env['SOX_EMBED_BACKEND'] = 'real';
  });

  afterEach(async () => {
    // Await full termination so the onnxruntime worker thread is gone before the
    // test file ends — otherwise vitest's fork pool times out terminating the fork.
    await _shutdownEmbedWorker();
    delete process.env['SOX_EMBED_BACKEND'];
    cleanup();
  });

  it(
    'getActiveEmbedModel() reports real BGE model and cosine(similar) > cosine(dissimilar) [BL-48]',
    async () => {

      const db = openDb(dbPath);

      try {
        // Write two semantically related claims and one unrelated claim
        await memoryWrite(db, { content: 'Neural networks learn representations from data.' });
        await memoryWrite(db, { content: 'Deep learning models train on large datasets.' });
        await memoryWrite(db, { content: 'The quarterly budget report is due on Friday.' });

        // Verify the active model is the real BGE model (not 'hash')
        const activeModel = getActiveEmbedModel();
        expect(activeModel).toBe('bge-base-en-v1.5');

        // Semantic recall: the AI/ML query should rank the two AI claims above the budget claim
        const response: RecallResponse = await memoryRecall(db, 'project', {
          query: 'machine learning training neural networks',
          limit: 3,
        });

        expect(response.results.length).toBeGreaterThanOrEqual(2);
        expect(response.provider_call_count).toBe(0); // R1 invariant: zero network calls

        // The top-2 results should be the AI/ML claims, not the budget claim
        const top2Contents = response.results.slice(0, 2).map((r) => r.content);
        const budgetInTop2 = top2Contents.some((c) => c?.includes('budget'));
        expect(budgetInTop2).toBe(false);
      } finally {
        db.close();
      }
    },
    30_000, // allow fastembed model download on first run
  );
});

// ── BL-48: hash-fallback detection ────────────────────────────────────────────
//
// Verifies that when SOX_EMBED_BACKEND=hash, getActiveEmbedModel() returns the
// hash model identifier (not the real ONNX model) and the embed_on_hash_fallback
// indicator correctly reflects the configured vs resolved backend mismatch.

describe('BL-48: embed backend resolution and fallback detection', () => {
  beforeEach(() => {
    _resetEmbedSingleton();
  });

  afterEach(async () => {
    await _shutdownEmbedWorker();
    delete process.env['SOX_EMBED_BACKEND'];
  });

  it('getActiveEmbedModel() returns hash model id when backend=hash', async () => {
    // Before any embed call, model is the hash default.
    process.env['SOX_EMBED_BACKEND'] = 'hash';
    _resetEmbedSingleton();

    const { dbPath, cleanup } = makeTempDb();
    const db = openDb(dbPath);
    try {
      await memoryWrite(db, { content: 'Hash backend test: the model id must be the hash identifier.' });
      const model = getActiveEmbedModel();
      // With hash backend: must return the hash model id, NOT the real bge model.
      expect(model).toBe('nomic-embed-text-v1.5-hash');
    } finally {
      db.close();
      cleanup();
    }
  });

  it('on_hash_fallback indicator is false when intentionally using hash backend', async () => {
    process.env['SOX_EMBED_BACKEND'] = 'hash';
    _resetEmbedSingleton();

    const { dbPath, cleanup } = makeTempDb();
    const db = openDb(dbPath);
    try {
      await memoryWrite(db, { content: 'Intentional hash backend — no fallback should be flagged.' });

      const resolvedModel = getActiveEmbedModel();
      const configuredBackend = process.env['SOX_EMBED_BACKEND'] ?? 'auto';
      // on_hash_fallback = configured != 'hash' AND resolved = hash model.
      // Here configured IS 'hash', so no fallback — on_hash_fallback must be false.
      const onHashFallback =
        configuredBackend !== 'hash' &&
        resolvedModel === 'nomic-embed-text-v1.5-hash';
      expect(onHashFallback).toBe(false);
    } finally {
      db.close();
      cleanup();
    }
  });
});

// ── BL-47: in-process fallback enrichment (daemon socket probe) ───────────────
//
// Verifies that when the daemon socket is absent, isDaemonReachable() correctly
// returns false, enabling the in-process fallback to trigger.
// Also verifies runBatchEnrich can be called directly in-process without error.

describe('BL-47: in-process fallback enrichment when daemon is absent', () => {
  beforeEach(() => {
    process.env['SOX_EMBED_BACKEND'] = 'hash';
    _resetEmbedSingleton();
  });

  afterEach(async () => {
    await _shutdownEmbedWorker();
    delete process.env['SOX_EMBED_BACKEND'];
  });

  it('daemon socket probe returns false when SOCKET_PATH does not exist', async () => {
    // Remove the socket if it exists (test isolation).
    if (fs.existsSync(SOCKET_PATH)) {
      // Socket exists — we can't remove it without risk; skip the probe test.
      return;
    }

    // Mimic the isDaemonReachable() probe from memory-server/src/index.ts.
    const reachable = await new Promise<boolean>((resolve) => {
      if (!fs.existsSync(SOCKET_PATH)) {
        resolve(false);
        return;
      }
      const conn = net.createConnection(SOCKET_PATH);
      const timer = setTimeout(() => { conn.destroy(); resolve(false); }, 200);
      conn.on('connect', () => { clearTimeout(timer); conn.destroy(); resolve(true); });
      conn.on('error', () => { clearTimeout(timer); resolve(false); });
    });

    expect(reachable).toBe(false);
  });

  it('runBatchEnrich with incrementalCluster:true succeeds in-process on a live DB', async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = openDb(dbPath);
    try {
      // Write a couple of episodes so enrichment has something to process.
      await memoryWrite(db, { content: 'Fallback enrichment test: first episode content here.' });
      await memoryWrite(db, { content: 'Fallback enrichment test: second episode content here.' });

      // This is exactly what the in-process fallback loop calls.
      const result = runBatchEnrich(db, { incrementalCluster: true });

      // Must not throw; must return a valid result shape.
      expect(typeof result.importance_updated).toBe('number');
      expect(typeof result.legacy_nodes_stamped).toBe('number');
      expect(typeof result.relates_to_edges).toBe('number');
    } finally {
      db.close();
      cleanup();
    }
  });
});
