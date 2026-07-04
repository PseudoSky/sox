/**
 * update.spec.ts — memoryUpdate end-to-end tests.
 *
 * Covers:
 *   - uid-not-found → E_NOT_FOUND
 *   - each replaceable field actually updates in DB
 *   - t_created is immutable; t_updated is set on every successful update
 *   - deep-merge: nested object merged, array replaced
 *   - metadata_merge:'replace' overwrites meta wholesale
 *   - content update re-embeds (vec_node vector changes) while metadata-only does NOT
 *   - FTS reflects content change (fts_node_au trigger fires on node UPDATE)
 *   - no-op (all values identical) → E_NO_FIELDS
 *
 * All operations are deterministic — SOX_EMBED_BACKEND=hash, no ONNX, no LLM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryUpdate, deepMerge } from './update.js';
import { _shutdownEmbedWorker } from './embed.js';

// Force hash backend — deterministic, no ONNX required.
process.env['SOX_EMBED_BACKEND'] = 'hash';

// ── Test DB helpers ───────────────────────────────────────────────────────────

function tmpDb(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memupdate-'));
  const db = openDb(path.join(dir, 'test.db'));
  return { db, dir };
}

function cleanup(db: Database.Database, dir: string): void {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

afterAll(async () => {
  await _shutdownEmbedWorker();
});

// ── Helper to fetch the raw vec_node embedding as a hex string ───────────────
// We convert to hex so we can use .toBe() for stable identity comparison.
// Buffer references from virtual tables are new instances on each read but
// have identical bytes — we need content equality, not reference equality.

function getVecHex(db: Database.Database, rowid: number): string | null {
  const row = db
    .prepare<[number], { embedding: Buffer | null }>(
      `SELECT embedding FROM vec_node WHERE node_id = CAST(? AS INTEGER)`,
    )
    .get(rowid);
  if (!row?.embedding) return null;
  return Buffer.from(row.embedding).toString('hex');
}

// ── Helper to read the full node row ─────────────────────────────────────────

interface NodeRow {
  rowid: number;
  uid: string;
  content: string | null;
  summary: string | null;
  name: string | null;
  topic: string | null;
  tags: string | null;
  importance: number;
  meta: string | null;
  t_created: string;
  t_updated: string | null;
  t_occurred: string | null;
  t_valid: string | null;
}

function getNode(db: Database.Database, uid: string): NodeRow | undefined {
  return db
    .prepare<[string], NodeRow>(
      `SELECT rowid, uid, content, summary, name, topic, tags, importance, meta,
              t_created, t_updated, t_occurred, t_valid
       FROM node WHERE uid = ?`,
    )
    .get(uid);
}

// ── deepMerge unit tests ─────────────────────────────────────────────────────

describe('deepMerge helper', () => {
  it('merges nested objects recursively', () => {
    const result = deepMerge(
      { a: { x: 1, y: 2 }, b: 'hello' },
      { a: { y: 99, z: 3 } },
    );
    expect(result).toEqual({ a: { x: 1, y: 99, z: 3 }, b: 'hello' });
  });

  it('replaces arrays (not concatenates)', () => {
    const result = deepMerge(
      { list: [1, 2, 3] },
      { list: [4, 5] },
    );
    expect(result).toEqual({ list: [4, 5] });
  });

  it('adds new top-level keys', () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('source scalar overwrites target scalar', () => {
    const result = deepMerge({ x: 'old' }, { x: 'new' });
    expect(result).toEqual({ x: 'new' });
  });

  it('null in source replaces object in target', () => {
    const result = deepMerge({ a: { nested: true } }, { a: null });
    expect(result).toEqual({ a: null });
  });

  it('does not mutate either argument', () => {
    const target = { a: { x: 1 } };
    const source = { a: { y: 2 } };
    deepMerge(target, source);
    expect(target).toEqual({ a: { x: 1 } });
    expect(source).toEqual({ a: { y: 2 } });
  });
});

// ── E_NOT_FOUND ───────────────────────────────────────────────────────────────

describe('memoryUpdate — E_NOT_FOUND', () => {
  it('returns E_NOT_FOUND for an unknown uid', async () => {
    const { db, dir } = tmpDb();
    try {
      const result = await memoryUpdate(db, {
        uid: '01JXNONEXISTENT',
        content: 'new content',
      });
      expect(result).toMatchObject({ code: 'E_NOT_FOUND' });
    } finally {
      cleanup(db, dir);
    }
  });

  it('returns E_NOT_FOUND for an invalidated node', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'will be invalidated' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      db.prepare(`UPDATE node SET t_invalid = ? WHERE uid = ?`).run(
        new Date().toISOString(),
        uid,
      );
      const result = await memoryUpdate(db, { uid, content: 'should fail' });
      expect(result).toMatchObject({ code: 'E_NOT_FOUND' });
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── E_NO_FIELDS ──────────────────────────────────────────────────────────────

describe('memoryUpdate — E_NO_FIELDS', () => {
  it('returns E_NO_FIELDS when no updatable params supplied', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'initial content' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const result = await memoryUpdate(db, { uid });
      expect(result).toMatchObject({ code: 'E_NO_FIELDS' });
    } finally {
      cleanup(db, dir);
    }
  });

  it('returns E_NO_FIELDS when supplied value is identical to existing', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, {
        content: 'same content',
        importance: 5,
      });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const result = await memoryUpdate(db, { uid, content: 'same content' });
      expect(result).toMatchObject({ code: 'E_NO_FIELDS' });
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── Field update tests ────────────────────────────────────────────────────────

describe('memoryUpdate — individual field updates', () => {
  it('updates content and reports reembedded:true', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'original content' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;

      const result = await memoryUpdate(db, { uid, content: 'updated content' });
      expect('uid' in result).toBe(true);
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.uid).toBe(uid);
      expect(ok.updated_fields).toContain('content');
      expect(ok.reembedded).toBe(true);

      const nodeAfter = getNode(db, uid)!;
      expect(nodeAfter.content).toBe('updated content');

      // t_created is immutable
      expect(nodeAfter.t_created).toBe(nodeBefore.t_created);
      // t_updated is set
      expect(nodeAfter.t_updated).not.toBeNull();
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates summary and reports reembedded:true', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'content', summary: 'old summary' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, summary: 'new summary' });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('summary');
      expect(ok.reembedded).toBe(true);

      const node = getNode(db, uid)!;
      expect(node.summary).toBe('new summary');
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates name', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'episode content', name: 'old name' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, name: 'new name' });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('name');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.name).toBe('new name');
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates topic', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'content about TS', topic: 'typescript' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, topic: 'javascript' });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('topic');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.topic).toBe('javascript');
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates tags', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'tag test', tags: ['a', 'b'] });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, tags: ['c', 'd', 'e'] });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('tags');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(JSON.parse(node.tags!)).toEqual(['c', 'd', 'e']);
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates importance', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'importance test', importance: 2 });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, { uid, importance: 8 });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('importance');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.importance).toBe(8);
    } finally {
      cleanup(db, dir);
    }
  });

  it('updates t_occurred and t_valid', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'temporal test' });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const newOccurred = '2024-01-01T00:00:00.000Z';
      const newValid = '2024-06-01T00:00:00.000Z';
      const result = await memoryUpdate(db, {
        uid,
        t_occurred: newOccurred,
        t_valid: newValid,
      });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('t_occurred');
      expect(ok.updated_fields).toContain('t_valid');
      expect(ok.reembedded).toBe(false);

      const node = getNode(db, uid)!;
      expect(node.t_occurred).toBe(newOccurred);
      expect(node.t_valid).toBe(newValid);
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── t_created immutability + t_updated audit ─────────────────────────────────

describe('memoryUpdate — t_created immutable, t_updated set', () => {
  it('never changes t_created; always sets t_updated', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'time anchor test' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;
      // t_updated is now set by enrichOnWrite → graph.touch() so it's no longer null
      expect(nodeBefore.t_updated).toEqual(expect.any(String));

      const before = Date.now();
      const result = await memoryUpdate(db, { uid, importance: 7 });
      expect('uid' in result).toBe(true);
      const after = Date.now();

      const nodeAfter = getNode(db, uid)!;
      // t_created must not change
      expect(nodeAfter.t_created).toBe(nodeBefore.t_created);
      // t_updated must be set and within the call window
      expect(nodeAfter.t_updated).not.toBeNull();
      const updatedMs = new Date(nodeAfter.t_updated!).getTime();
      expect(updatedMs).toBeGreaterThanOrEqual(before);
      expect(updatedMs).toBeLessThanOrEqual(after + 50); // small tolerance
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── metadata deep-merge vs replace ───────────────────────────────────────────

describe('memoryUpdate — metadata merging', () => {
  it('deep-merges by default: nested objects merged, arrays replaced', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, {
        content: 'meta merge test',
        metadata: { a: { x: 1 }, list: [1, 2, 3], stable: 'keep' },
      });
      const uid = (wr as { episode_uid: string }).episode_uid;

      // Verify initial meta
      const nodeBefore = getNode(db, uid)!;
      const metaBefore = JSON.parse(nodeBefore.meta!) as Record<string, unknown>;
      expect(metaBefore).toMatchObject({ a: { x: 1 }, list: [1, 2, 3], stable: 'keep' });

      const result = await memoryUpdate(db, {
        uid,
        metadata: { a: { y: 2 }, list: [4, 5] },
        // metadata_merge defaults to 'deep'
      });
      expect('uid' in result).toBe(true);
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.updated_fields).toContain('meta');
      expect(ok.reembedded).toBe(false);

      const nodeAfter = getNode(db, uid)!;
      const metaAfter = JSON.parse(nodeAfter.meta!) as Record<string, unknown>;

      // Nested object merged: a.x preserved, a.y added
      expect(metaAfter['a']).toEqual({ x: 1, y: 2 });
      // Array replaced (not concatenated)
      expect(metaAfter['list']).toEqual([4, 5]);
      // Untouched key preserved
      expect(metaAfter['stable']).toBe('keep');
    } finally {
      cleanup(db, dir);
    }
  });

  it("metadata_merge:'replace' overwrites meta wholesale", async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, {
        content: 'meta replace test',
        metadata: { old_key: 'will be gone', nested: { deep: true } },
      });
      const uid = (wr as { episode_uid: string }).episode_uid;

      const result = await memoryUpdate(db, {
        uid,
        metadata: { brand_new: 42 },
        metadata_merge: 'replace',
      });
      expect('uid' in result).toBe(true);

      const nodeAfter = getNode(db, uid)!;
      const metaAfter = JSON.parse(nodeAfter.meta!) as Record<string, unknown>;
      expect(metaAfter).toEqual({ brand_new: 42 });
      expect('old_key' in metaAfter).toBe(false);
      expect('nested' in metaAfter).toBe(false);
    } finally {
      cleanup(db, dir);
    }
  });

  it('metadata-only update does NOT re-embed', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'embed stability test' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;
      const vecBefore = getVecHex(db, nodeBefore.rowid);
      expect(vecBefore).not.toBeNull();

      const result = await memoryUpdate(db, {
        uid,
        metadata: { tag: 'added' },
      });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.reembedded).toBe(false);

      const vecAfter = getVecHex(db, nodeBefore.rowid);
      // Vector must be unchanged (same blob) for a metadata-only update.
      expect(vecAfter).toBe(vecBefore);
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── Re-embed proof ────────────────────────────────────────────────────────────

describe('memoryUpdate — re-embed on content change', () => {
  it('vec_node vector changes when content updates', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'first version of the content' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;
      const vecBefore = getVecHex(db, nodeBefore.rowid);
      expect(vecBefore).not.toBeNull();

      // Update with a distinctly different content string (hash backend produces
      // content-dependent embeddings, so different text → different vector).
      const result = await memoryUpdate(db, {
        uid,
        content: 'completely different second version with new words',
      });
      const ok = result as import('./update.js').UpdateResult;
      expect(ok.reembedded).toBe(true);
      expect(ok.updated_fields).toContain('content');

      const vecAfter = getVecHex(db, nodeBefore.rowid);
      // The blob must have changed (different content → different hash embedding).
      expect(vecAfter).not.toBeNull();
      expect(vecAfter).not.toBe(vecBefore);
    } finally {
      cleanup(db, dir);
    }
  });

  it('vec_node vector unchanged for a non-content/summary update', async () => {
    const { db, dir } = tmpDb();
    try {
      const wr = await memoryWrite(db, { content: 'stable content for vector test' });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeBefore = getNode(db, uid)!;
      const vecBefore = getVecHex(db, nodeBefore.rowid);

      await memoryUpdate(db, { uid, topic: 'new-topic' });

      const vecAfter = getVecHex(db, nodeBefore.rowid);
      // Vector must be identical for a topic-only update.
      expect(vecAfter).toBe(vecBefore);
    } finally {
      cleanup(db, dir);
    }
  });
});

// ── FTS sync via trigger ──────────────────────────────────────────────────────

describe('memoryUpdate — FTS reflects content change (fts_node_au trigger)', () => {
  /**
   * The fts_node_au trigger fires AFTER UPDATE ON node and re-indexes all three
   * FTS columns: content, name, summary. When only content changes, FTS still
   * re-indexes the current summary value — so a term that appears in BOTH content
   * AND summary will remain indexed if only the content column is updated.
   *
   * This test uses a unique term that appears ONLY in content (not summary) and
   * verifies the trigger correctly removes it from the FTS index after a content
   * update, then adds the new content's unique term.
   *
   * To guarantee the unique term is never in summary, we write a node with an
   * explicit summary that uses different vocabulary.
   */
  it('fts_node indexes new content terms and removes old content-only terms', async () => {
    const { db, dir } = tmpDb();
    try {
      // Write with an explicit summary that does NOT contain the unique content term.
      const wr = await memoryWrite(db, {
        content: 'the quick zorbflux ran over the lazy dog',
        summary: 'canine speed test',   // no 'zorbflux' here
      });
      const uid = (wr as { episode_uid: string }).episode_uid;
      const nodeRow = db
        .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`)
        .get(uid)!;

      // 'zorbflux' should be indexed before the update.
      const ftsBeforeRows = db
        .prepare<[string], { rowid: number }>(
          `SELECT rowid FROM fts_node WHERE fts_node MATCH ?`,
        )
        .all('zorbflux');
      expect(ftsBeforeRows.map((r) => r.rowid)).toContain(nodeRow.rowid);

      // Update content + summary together — replace the unique term with a new one.
      await memoryUpdate(db, {
        uid,
        content: 'a completely different quaxbeam story',
        summary: 'quaxbeam narrative',
      });

      // 'quaxbeam' should now be indexed.
      const ftsAfterRows = db
        .prepare<[string], { rowid: number }>(
          `SELECT rowid FROM fts_node WHERE fts_node MATCH ?`,
        )
        .all('quaxbeam');
      expect(ftsAfterRows.map((r) => r.rowid)).toContain(nodeRow.rowid);

      // 'zorbflux' should no longer be indexed for this episode — it appeared only in
      // content (and summary), both of which were updated to remove it.
      const ftsRemovedRows = db
        .prepare<[string], { rowid: number }>(
          `SELECT rowid FROM fts_node WHERE fts_node MATCH ?`,
        )
        .all('zorbflux');
      expect(ftsRemovedRows.map((r) => r.rowid)).not.toContain(nodeRow.rowid);
    } finally {
      cleanup(db, dir);
    }
  });
});
